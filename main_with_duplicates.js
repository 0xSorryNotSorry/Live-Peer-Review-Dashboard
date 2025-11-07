import { graphql } from "@octokit/graphql";
import fs from "fs/promises";
import dotenv from "dotenv";
import puppeteer from "puppeteer";

dotenv.config();

// Color constants for consistent styling
const COLORS = {
    GREEN: "#ccffcc", // High percentage/positive
    YELLOW: "#ffffcc", // Medium-high percentage
    ORANGE: "#ffeb9c", // Medium-low percentage
    RED: "#ffcccc", // Low percentage/negative
};

// Thresholds for color transitions
const THRESHOLD = {
    HIGH: 90, // Green
    MEDIUM: 70, // Yellow
    LOW: 50, // Orange, below this is red
};

// Initialize the GraphQL client with authentication
const graphqlWithAuth = graphql.defaults({
    headers: {
        authorization: `token ${process.env.GITHUB_TOKEN}`,
    },
});

// Load configuration from a specified path or default to "config.json" in the current directory
async function loadConfig(configPath = "./config.json") {
    try {
        const data = await fs.readFile(configPath, "utf8");
        return JSON.parse(data);
    } catch (error) {
        console.error("Error reading config file:", error);
        return [];
    }
}

function formatDateTime(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Helper function to truncate comment text to 50 words
function truncateText(text, charLimit = 300) {
    if (text.length <= charLimit) {
        return text;
    }
    return text.slice(0, charLimit).concat("...");
}

// Helper function to extract DUP marker from comment body
// Matches patterns like: DUP <url> or DUP: <url> or DUP <url>
function extractDuplicateMarker(commentBody) {
    // Match "DUP" followed by optional colon/whitespace and a GitHub URL
    const dupRegex = /DUP\s*:?\s*<?(https:\/\/github\.com\/[^\s>]+)>?/i;
    const match = commentBody.match(dupRegex);
    return match ? match[1] : null;
}

// Helper function to extract comment ID from GitHub URL
function extractCommentIdFromUrl(url) {
    // GitHub review comment URLs look like:
    // https://github.com/owner/repo/pull/123#discussion_r1234567890
    const match = url.match(/discussion_r(\d+)/);
    return match ? match[1] : null;
}

// Fetch PR review comments with reactions using GraphQL
async function getPRReviewCommentsWithReactions(owner, repo, pullRequestNumber) {
    const rows = []; // Array to hold each comment's data for Excel or PDF
    const commenters = [];
    const comments = []; // Store all comments for later reaction processing
    // Counter for issues statistics
    const stats = {
        reported: 0, // Resolved with rocket (✅)
        nonReported: 0, // Resolved without rocket (❌)
        pending: 0, // Not resolved (no status)
    };
    
    // Track duplicate relationships
    const duplicateMap = new Map(); // Maps duplicate URL -> original URL
    const originalToDuplicates = new Map(); // Maps original URL -> array of duplicate URLs

    try {
        // GraphQL query to fetch review threads, comments, and reactions
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

        // First pass: collect all commenters and build comment data
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

                // Check for duplicate marker in comment body
                const duplicateOriginalUrl = extractDuplicateMarker(commentText);
                const isDuplicate = duplicateOriginalUrl !== null;

                // Row with the clickable comment text as a hyperlink
                const row = {
                    Comment: { text: truncatedText, hyperlink: commentUrl },
                    proposer: commenter.login,
                    isDuplicate: isDuplicate,
                    duplicateOf: duplicateOriginalUrl,
                    commentUrl: commentUrl,
                };

                // Only set Reported status for resolved comments
                // Not resolved comments don't get a Reported status

                // Process reactions
                const reactions = comment.reactions.nodes;

                // Initialize reaction counts
                row.thumbsUpCount = 0;
                row.thumbsDownCount = 0;
                row[commenter.login] = "Proposer";
                row.reactions = {}; // Track who reacted

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

                // Set Reported status based on isResolved and hasRocket
                if (isResolved) {
                    row.Reported = hasRocket ? "✅" : "❌";
                    // Update stats (don't count duplicates in main stats)
                    if (!isDuplicate) {
                        if (hasRocket) {
                            stats.reported++;
                        } else {
                            stats.nonReported++;
                        }
                    }
                } else {
                    // Not resolved -> pending (don't count duplicates)
                    if (!isDuplicate) {
                        stats.pending++;
                    }
                }

                // Track duplicate relationships
                if (isDuplicate) {
                    duplicateMap.set(commentUrl, duplicateOriginalUrl);
                    
                    if (!originalToDuplicates.has(duplicateOriginalUrl)) {
                        originalToDuplicates.set(duplicateOriginalUrl, []);
                    }
                    originalToDuplicates.get(duplicateOriginalUrl).push({
                        url: commentUrl,
                        proposer: commenter.login,
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

    // Initialize reaction tracker with all commenters
    const reactionsTracker = {};
    commenters.forEach((username) => {
        reactionsTracker[username] = { reacted: 0, total: 0 };
    });

    // Second pass: calculate reactions and totals
    comments.forEach((comment) => {
        const proposer = comment.proposer;

        // For each commenter, increment their total count (except for the comment proposer)
        commenters.forEach((username) => {
            if (username !== proposer) {
                reactionsTracker[username].total += 1;

                // Check if this user reacted to this comment
                if (comment.reactions[username]) {
                    reactionsTracker[username].reacted += 1;
                }
            }
        });
    });

    // Calculate percentages and format totals
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

    // Build duplicate groups and assign them
    const duplicateGroups = buildDuplicateGroups(originalToDuplicates, rows);
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

// Build duplicate groups with original finding info
function buildDuplicateGroups(originalToDuplicates, rows) {
    const groups = [];
    
    for (const [originalUrl, duplicates] of originalToDuplicates.entries()) {
        // Find the original finding in rows
        const originalRow = rows.find(r => r.commentUrl === originalUrl);
        
        groups.push({
            originalUrl: originalUrl,
            originalProposer: originalRow ? originalRow.proposer : 'Unknown',
            originalComment: originalRow ? originalRow.Comment.text : 'Original not found',
            duplicates: duplicates,
            count: duplicates.length,
        });
    }
    
    return groups;
}

// Assign duplicates evenly across auditors
function assignDuplicates(duplicateGroups, commenters) {
    const assignments = {};
    
    // Initialize assignments for each commenter
    commenters.forEach(commenter => {
        assignments[commenter] = [];
    });
    
    // For each duplicate group, assign duplicates round-robin
    duplicateGroups.forEach(group => {
        // Get all unique proposers from duplicates
        const duplicateProposers = [...new Set(group.duplicates.map(d => d.proposer))];
        
        // Sort for consistent assignment
        duplicateProposers.sort();
        
        // Assign each duplicate to its proposer
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

// Function to get color based on percentage
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

// Function to map reaction content to emoji
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

async function renderPDF(repos, name) {
    const generatedOn = formatDateTime(new Date()); // Get current date and time
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

        // Add a title for each PR
        htmlContent += `<h1>${owner}/${repo} - Pull Request #${pullRequestNumber}</h1>`;

        // Add issues summary table
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

        // Add reaction stats summary table
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

        // Add duplicate groups summary if any exist
        if (duplicateGroups.length > 0) {
            htmlContent += `
              <h2>Duplicate Findings (${duplicateGroups.length} groups)</h2>
              <table>
                <tr>
                  <th>Original Finding</th>
                  <th>Original Proposer</th>
                  <th>Duplicates</th>
                  <th>Count</th>
                </tr>
            `;

            duplicateGroups.forEach(group => {
                htmlContent += `
                  <tr>
                    <td><a href="${group.originalUrl}">${group.originalComment}</a></td>
                    <td>${group.originalProposer}</td>
                    <td>`;
                
                group.duplicates.forEach((dup, idx) => {
                    htmlContent += `<a href="${dup.url}">${dup.proposer}</a>`;
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

        // Add duplicate assignments per auditor
        if (Object.keys(duplicateAssignments).some(key => duplicateAssignments[key].length > 0)) {
            htmlContent += `
              <h2>Duplicate Assignments (for reporting)</h2>
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

        // Prepare table headers for comments
        const headers = ["Comment", "Reported", "Duplicate", ...commenters];
        htmlContent += `<h2>All Comments</h2><table><tr>`;
        headers.forEach((header) => {
            htmlContent += `<th>${header}</th>`;
        });
        htmlContent += `</tr>`;

        // Add table rows
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

            // Comment column with hyperlink
            htmlContent += `<td><a href="${dataRow.Comment.hyperlink}">${dataRow.Comment.text}</a></td>`;

            // Reported column
            htmlContent += `<td>${dataRow.Reported || ""}</td>`;

            // Duplicate column
            if (dataRow.isDuplicate) {
                htmlContent += `<td><a href="${dataRow.duplicateOf}">DUP</a></td>`;
            } else {
                htmlContent += `<td></td>`;
            }

            // Reactions from commenters
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

    // Launch Puppeteer and generate PDF
    console.info("Generating PDF...");
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // Set HTML content
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });

    // Generate PDF with landscape orientation
    await page.pdf({
        path: `${name}.pdf`,
        format: "A4",
        landscape: true, // Set landscape orientation
        printBackground: true,
        margin: { top: "20mm", bottom: "20mm", left: "10mm", right: "10mm" },
    });

    await browser.close();
    console.info(`PDF file created: ${name}.pdf`);
}

// Main function to process each PR from config
async function main(configPath) {
    const config = await loadConfig(configPath);

    const repos = config.repositories;

    if (repos.length === 0) {
        console.error("No repositories and pull requests found in config.");
        return;
    }

    await renderPDF(repos, config.name);
}

// Parse command-line arguments
const args = process.argv.slice(2);
let configPath = "./config.json";

args.forEach((arg) => {
    if (arg.startsWith("--config-path=")) {
        configPath = arg.split("=")[1];
    }
});

// Run the main function with the provided config path
main(configPath);
