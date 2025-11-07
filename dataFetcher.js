import { graphql } from "@octokit/graphql";
import fs from "fs/promises";
import dotenv from "dotenv";
import puppeteer from "puppeteer";

dotenv.config();

// Color constants for consistent styling
const COLORS = {
    GREEN: "#ccffcc",
    YELLOW: "#ffffcc",
    ORANGE: "#ffeb9c",
    RED: "#ffcccc",
};

// Thresholds for color transitions
const THRESHOLD = {
    HIGH: 90,
    MEDIUM: 70,
    LOW: 50,
};

// Initialize the GraphQL client with authentication
const graphqlWithAuth = graphql.defaults({
    headers: {
        authorization: `token ${process.env.GITHUB_TOKEN}`,
    },
});

function formatDateTime(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function truncateText(text, charLimit = 300) {
    if (text.length <= charLimit) {
        return text;
    }
    return text.slice(0, charLimit).concat("...");
}

// Helper function to extract DUP marker from comment body
// Matches patterns like: Dup `<url>` or DUP <url>
function extractDuplicateMarker(commentBody) {
    // Match "DUP" or "Dup" followed by a GitHub URL in angle brackets (with optional backticks)
    // Format: Dup `<https://github.com/...>` or Dup <https://github.com/...>
    const dupRegex = /(?:DUP|Dup)\s+`?<(https:\/\/github\.com\/[^>]+)>`?/i;
    const match = commentBody.match(dupRegex);
    return match ? match[1] : null;
}

// Helper function to extract comment ID from GitHub URL
function extractCommentIdFromUrl(url) {
    const match = url.match(/discussion_r(\d+)/);
    return match ? match[1] : null;
}

// Fetch PR review comments with reactions using GraphQL
export async function getPRReviewCommentsWithReactions(owner, repo, pullRequestNumber, undupeFlags = {}) {
    const rows = [];
    const commenters = [];
    const comments = [];
    const stats = {
        reported: 0,
        nonReported: 0,
        pending: 0,
    };
    
    const duplicateMap = new Map();
    const originalToDuplicates = new Map();

    try {
        const query = `
      query ($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullRequestNumber) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 1) {
                  nodes {
                    id
                    body
                    url
                    author {
                      login
                    }
                    reactions(first: 50) {
                      nodes {
                        content
                        user {
                          login
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

        const result = await graphqlWithAuth(query, {
            owner,
            repo,
            pullRequestNumber,
        });

        const reviewThreads = result.repository.pullRequest.reviewThreads.nodes;

        for (const thread of reviewThreads) {
            const isResolved = thread.isResolved;

            for (const comment of thread.comments.nodes) {
                const {
                    id: commentId,
                    body: commentText,
                    url: commentUrl,
                    author: commenter,
                } = comment;

                const truncatedText = truncateText(commentText);

                if (!commenters.includes(commenter.login)) {
                    commenters.push(commenter.login);
                }

                const duplicateOriginalUrl = extractDuplicateMarker(commentText);
                const isDuplicate = duplicateOriginalUrl !== null;

                const row = {
                    Comment: { text: truncatedText, hyperlink: commentUrl },
                    proposer: commenter.login,
                    isDuplicate: isDuplicate,
                    duplicateOf: duplicateOriginalUrl,
                    commentUrl: commentUrl,
                };

                const reactions = comment.reactions.nodes;

                row.thumbsUpCount = 0;
                row.thumbsDownCount = 0;
                row[commenter.login] = "Proposer";
                row.reactions = {};

                let hasRocket = false;

                reactions.forEach((reaction) => {
                    const user = reaction.user.login;
                    if (!commenters.includes(user)) {
                        commenters.push(user);
                    }
                    const emoji = getEmoji(reaction.content);

                    switch (emoji) {
                        case "🚀":
                            hasRocket = true;
                            break;
                        case "👍":
                            row[user] = emoji;
                            row.thumbsUpCount += 1;
                            row.reactions[user] = true;
                            break;
                        case "👎":
                            row[user] = emoji;
                            row.thumbsDownCount += 1;
                            row.reactions[user] = true;
                            break;
                        case "👀":
                            break;
                        default:
                            console.warn("Incorrect emoji", emoji, user, commentUrl);
                    }
                });

                if (isResolved) {
                    row.Reported = hasRocket ? "✅" : "❌";
                    if (!isDuplicate) {
                        if (hasRocket) {
                            stats.reported++;
                        } else {
                            stats.nonReported++;
                        }
                    }
                } else {
                    if (!isDuplicate) {
                        stats.pending++;
                    }
                }

                if (isDuplicate) {
                    duplicateMap.set(commentUrl, duplicateOriginalUrl);
                    
                    if (!originalToDuplicates.has(duplicateOriginalUrl)) {
                        originalToDuplicates.set(duplicateOriginalUrl, []);
                    }
                    originalToDuplicates.get(duplicateOriginalUrl).push({
                        url: commentUrl,
                        proposer: commenter.login,
                        isManual: true, // This is a manually marked duplicate
                    });
                }

                rows.push(row);
                comments.push(row);
            }
        }
    } catch (error) {
        console.error(
            `Error fetching review comments or reactions for ${owner}/${repo} - PR #${pullRequestNumber}:`,
            error,
        );
    }

    const reactionsTracker = {};
    commenters.forEach((username) => {
        reactionsTracker[username] = { reacted: 0, total: 0 };
    });

    comments.forEach((comment) => {
        const proposer = comment.proposer;

        commenters.forEach((username) => {
            if (username !== proposer) {
                reactionsTracker[username].total += 1;

                if (comment.reactions[username]) {
                    reactionsTracker[username].reacted += 1;
                }
            }
        });
    });

    const reactionStats = {};
    commenters.forEach((username) => {
        const stats = reactionsTracker[username];
        const percentage =
            stats.total === 0 ? 100 : Math.round((stats.reacted / stats.total) * 100);
        reactionStats[username] = {
            text: `${stats.reacted}/${stats.total} (${percentage}%)`,
            percentage: percentage,
        };
    });

    // BIDIRECTIONAL DUPLICATE DETECTION
    // Create unified groups where all members are duplicates of each other
    const duplicateGroupsMap = new Map(); // Maps any URL in group to group ID
    let nextGroupId = 0;
    
    for (const [dupUrl, originalUrl] of duplicateMap.entries()) {
        const reverseKey = `${originalUrl}->${dupUrl}`;
        
        // Skip if manually unduped
        if (undupeFlags[reverseKey]) continue;
        
        // Check if either URL is already in a group
        let groupId = duplicateGroupsMap.get(dupUrl) || duplicateGroupsMap.get(originalUrl);
        
        if (!groupId) {
            // Create new group
            groupId = `group-${nextGroupId++}`;
        }
        
        // Add both URLs to the same group
        duplicateGroupsMap.set(dupUrl, groupId);
        duplicateGroupsMap.set(originalUrl, groupId);
        
        // Mark both as duplicates
        const dupRow = rows.find(r => r.commentUrl === dupUrl);
        const originalRow = rows.find(r => r.commentUrl === originalUrl);
        
        if (dupRow) {
            dupRow.isDuplicate = true;
            dupRow.duplicateGroupId = groupId;
        }
        if (originalRow) {
            originalRow.isDuplicate = true;
            originalRow.duplicateGroupId = groupId;
            originalRow.isAutoDuplicate = !duplicateMap.has(originalUrl); // Auto if not manually marked
        }
    }
    
    // Build unified duplicate groups
    const unifiedGroups = new Map();
    for (const row of rows) {
        if (row.isDuplicate && row.duplicateGroupId) {
            if (!unifiedGroups.has(row.duplicateGroupId)) {
                unifiedGroups.set(row.duplicateGroupId, []);
            }
            unifiedGroups.get(row.duplicateGroupId).push({
                url: row.commentUrl,
                proposer: row.proposer,
                isManual: !row.isAutoDuplicate
            });
        }
    }
    
    // Clear old structure and rebuild with unified groups
    originalToDuplicates.clear();
    for (const [groupId, members] of unifiedGroups.entries()) {
        // Use first member as "original" for the group
        const firstMember = members[0];
        originalToDuplicates.set(firstMember.url, members.slice(1));
    }

    // First pass: assign regular issue numbers
    let issueNumber = 1;
    rows.forEach(row => {
        if (!row.isDuplicate) {
            row.issueNumber = issueNumber;
            issueNumber++;
        }
    });

    // Build duplicate groups and assign numbers
    const duplicateGroups = [];
    let groupIndex = 0;
    
    for (const [originalUrl, duplicates] of originalToDuplicates.entries()) {
        groupIndex++;
        const groupNumber = `D-${groupIndex}`;
        const originalRow = rows.find(r => r.commentUrl === originalUrl);

        // Build a full members list including the original first, then the rest
        const members = [
            {
                url: originalUrl,
                proposer: originalRow ? originalRow.proposer : 'Unknown',
                isManual: originalRow ? !originalRow.isAutoDuplicate : true,
            },
            ...duplicates,
        ];

        // Assign sub-numbers to every member and stamp rows
        const membersWithNumbers = members.map((member, idx) => {
            const subIssueNumber = `${groupNumber}.${idx + 1}`;
            const memberRow = rows.find(r => r.commentUrl === member.url);
            if (memberRow) {
                memberRow.issueNumber = subIssueNumber;
                memberRow.groupNumber = groupNumber;
            }
            return {
                ...member,
                issueNumber: subIssueNumber,
            };
        });

        duplicateGroups.push({
            groupNumber: groupNumber,
            originalUrl: originalUrl,
            originalProposer: originalRow ? originalRow.proposer : 'Unknown',
            originalComment: originalRow ? originalRow.Comment.text : 'Original not found',
            originalIssueNumber: originalRow ? originalRow.issueNumber : 'N/A',
            duplicates: membersWithNumbers,
            count: membersWithNumbers.length,
        });
    }
    
    // Third pass: add other spotters info
    rows.forEach(row => {
        if (row.isDuplicate) {
            const group = duplicateGroups.find(g => {
                return g.duplicates.some(d => d.url === row.commentUrl);
            });
            if (group) {
                const otherSpotters = group.duplicates
                    .filter(dup => dup.url !== row.commentUrl)
                    .map(dup => {
                        const dupRow = rows.find(r => r.commentUrl === dup.url);
                        return `${dupRow.issueNumber} (${dup.proposer})`;
                    });
                
                row.otherSpotters = otherSpotters;
                row.groupNumber = group.groupNumber;
            }
        }
    });
    
    // Sort rows: regular issues first, then duplicates grouped together
    rows.sort((a, b) => {
        // Put duplicates first
        if (a.isDuplicate && !b.isDuplicate) return -1;
        if (!a.isDuplicate && b.isDuplicate) return 1;
        
        // If both non-duplicates, sort by ascending issueNumber (numeric)
        if (!a.isDuplicate && !b.isDuplicate) {
            return a.issueNumber - b.issueNumber;
        }
        
        // Both duplicates - sort by group number then sub-number
        if (a.groupNumber !== b.groupNumber) {
            return a.groupNumber.localeCompare(b.groupNumber);
        }
        return a.issueNumber.localeCompare(b.issueNumber);
    });

    const duplicateAssignments = assignDuplicates(duplicateGroups, commenters);

    return { 
        rows, 
        commenters, 
        reactionStats, 
        stats,
        duplicateGroups,
        duplicateAssignments,
    };
}


function assignDuplicates(duplicateGroups, commenters) {
    const assignments = {};
    
    commenters.forEach(commenter => {
        assignments[commenter] = [];
    });
    
    duplicateGroups.forEach(group => {
        const duplicateProposers = [...new Set(group.duplicates.map(d => d.proposer))];
        
        duplicateProposers.sort();
        
        group.duplicates.forEach(dup => {
            if (!assignments[dup.proposer]) {
                assignments[dup.proposer] = [];
            }
            
            assignments[dup.proposer].push({
                originalUrl: group.originalUrl,
                originalProposer: group.originalProposer,
                originalComment: group.originalComment,
                duplicateUrl: dup.url,
            });
        });
    });
    
    return assignments;
}

function getColorForPercentage(percentage) {
    if (percentage >= THRESHOLD.HIGH) {
        return COLORS.GREEN;
    } else if (percentage >= THRESHOLD.MEDIUM) {
        return COLORS.YELLOW;
    } else if (percentage >= THRESHOLD.LOW) {
        return COLORS.ORANGE;
    } else {
        return COLORS.RED;
    }
}

function getEmoji(content) {
    const emojiMap = {
        THUMBS_UP: "👍",
        THUMBS_DOWN: "👎",
        LAUGH: "😄",
        HOORAY: "🎉",
        CONFUSED: "😕",
        HEART: "❤️",
        ROCKET: "🚀",
        EYES: "👀",
    };
    return emojiMap[content.toUpperCase()] || content;
}

export async function generatePDF(repos, name) {
    const generatedOn = formatDateTime(new Date());
    let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Review Report</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 20px;
        }
        h1, h2 {
          text-align: center;
        }
        p.generated-on {
          text-align: right;
          font-style: italic;
          color: #555;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 40px;
        }
        th, td {
          border: 1px solid #dddddd;
          text-align: left;
          padding: 8px;
          vertical-align: top;
        }
        th {
          background-color: #f2f2f2;
        }
        .green-row {
          background-color: ${COLORS.GREEN};
        }
        .red-row {
          background-color: ${COLORS.RED};
        }
        a {
          color: #0066cc;
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
        }
        .summary-table {
          width: 50%;
          margin: 0 auto 30px auto;
        }
      </style>
    </head>
    <body>
        <p class="generated-on">Generated on ${generatedOn}</p>

  `;

    for (const { owner, repo, pullRequestNumber } of repos) {
        console.info(
            `\nProcessing ${owner}/${repo} - Pull Request #${pullRequestNumber}`,
        );
        const { rows, commenters, reactionStats, stats, duplicateGroups, duplicateAssignments } =
            await getPRReviewCommentsWithReactions(owner, repo, pullRequestNumber);

        htmlContent += `<h1>${owner}/${repo} - Pull Request #${pullRequestNumber}</h1>`;

        htmlContent += `
          <h2>Issues Summary</h2>
          <table class="summary-table">
            <tr>
              <th>Category</th>
              <th>Count</th>
            </tr>
            <tr>
              <td>Reported (✅)</td>
              <td style="background-color: ${COLORS.GREEN}">${stats.reported}</td>
            </tr>
            <tr>
              <td>Non-Reported (❌)</td>
              <td style="background-color: ${COLORS.RED}">${stats.nonReported}</td>
            </tr>
            <tr>
              <td>Pending</td>
              <td style="background-color: ${COLORS.YELLOW}">${stats.pending}</td>
            </tr>
          </table>
        `;

        htmlContent += `
          <h2>Reaction Completion Stats</h2>
          <table class="summary-table">
            <tr>
              <th>Reviewer</th>
              <th>Reactions Completed</th>
            </tr>
        `;

        commenters.forEach((commenter) => {
            const percentage = reactionStats[commenter].percentage;
            const color = getColorForPercentage(percentage);
            htmlContent += `
              <tr>
                <td>${commenter}</td>
                <td style="background-color: ${color}">${reactionStats[commenter].text}</td>
              </tr>
            `;
        });

        htmlContent += `</table>`;

        if (duplicateGroups.length > 0) {
            htmlContent += `
              <h2>Duplicate Findings (${duplicateGroups.length} groups)</h2>
              <table>
                <tr>
                  <th>#</th>
                  <th>Original Finding</th>
                  <th>Original Proposer</th>
                  <th>Duplicates</th>
                  <th>Count</th>
                </tr>
            `;

            duplicateGroups.forEach(group => {
                htmlContent += `
                  <tr>
                    <td><strong>${group.originalIssueNumber}</strong></td>
                    <td><a href="${group.originalUrl}">${group.originalComment}</a></td>
                    <td>${group.originalProposer}</td>
                    <td>`;
                
                group.duplicates.forEach((dup, idx) => {
                    htmlContent += `<a href="${dup.url}">${dup.issueNumber} (${dup.proposer})</a>`;
                    if (idx < group.duplicates.length - 1) {
                        htmlContent += ', ';
                    }
                });
                
                htmlContent += `</td>
                    <td>${group.count}</td>
                  </tr>
                `;
            });

            htmlContent += `</table>`;
        }

        if (Object.keys(duplicateAssignments).some(key => duplicateAssignments[key].length > 0)) {
            htmlContent += `
              <h2>Duplicates</h2>
              <table>
                <tr>
                  <th>Auditor</th>
                  <th>Assigned Duplicates</th>
                  <th>Count</th>
                </tr>
            `;

            commenters.forEach(commenter => {
                const assignments = duplicateAssignments[commenter] || [];
                if (assignments.length > 0) {
                    htmlContent += `
                      <tr>
                        <td>${commenter}</td>
                        <td>`;
                    
                    assignments.forEach((assignment, idx) => {
                        htmlContent += `<a href="${assignment.duplicateUrl}">Dup of ${assignment.originalProposer}'s finding</a>`;
                        if (idx < assignments.length - 1) {
                            htmlContent += '<br>';
                        }
                    });
                    
                    htmlContent += `</td>
                        <td>${assignments.length}</td>
                      </tr>
                    `;
                }
            });

            htmlContent += `</table>`;
        }

        const headers = ["#", "Comment", "Reported", "Duplicate", ...commenters];
        htmlContent += `<h2>All Comments</h2><table><tr>`;
        headers.forEach((header) => {
            htmlContent += `<th>${header}</th>`;
        });
        htmlContent += `</tr>`;

        rows.forEach((dataRow) => {
            const thumbsUpCount = dataRow.thumbsUpCount;
            const thumbsDownCount = dataRow.thumbsDownCount;
            const totalCommenters = commenters.length;

            let rowClass = "";
            if (thumbsUpCount + 1 >= (2 / 3) * totalCommenters) {
                rowClass = "green-row";
            } else if (thumbsDownCount >= (2 / 3) * (totalCommenters - 1)) {
                rowClass = "red-row";
            }

            htmlContent += `<tr class="${rowClass}">`;

            htmlContent += `<td><strong>${dataRow.issueNumber}</strong></td>`;

            htmlContent += `<td><a href="${dataRow.Comment.hyperlink}">${dataRow.Comment.text}</a></td>`;

            htmlContent += `<td>${dataRow.Reported || ""}</td>`;

            if (dataRow.isDuplicate) {
                let dupText = `<strong>${dataRow.proposer}</strong><br>`;
                dupText += `<a href="${dataRow.duplicateOf}">DUP of #${dataRow.originalIssueNumber} (${dataRow.originalProposer})</a>`;
                if (dataRow.otherSpotters && dataRow.otherSpotters.length > 0) {
                    dupText += `<br><small>Also spotted by: ${dataRow.otherSpotters.join(', ')}</small>`;
                }
                htmlContent += `<td>${dupText}</td>`;
            } else {
                htmlContent += `<td></td>`;
            }

            commenters.forEach((commenter) => {
                htmlContent += `<td>${dataRow[commenter] || ""}</td>`;
            });

            htmlContent += `</tr>`;
        });

        htmlContent += `</table>`;
    }

    htmlContent += `
    </body>
    </html>
  `;

    console.info("Generating PDF...");
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.setContent(htmlContent, { waitUntil: "networkidle0" });

    await page.pdf({
        path: `${name}.pdf`,
        format: "A4",
        landscape: true,
        printBackground: true,
        margin: { top: "20mm", bottom: "20mm", left: "10mm", right: "10mm" },
    });

    await browser.close();
    console.info(`PDF file created: ${name}.pdf`);
}



