import fs from "fs/promises";
import os from "os";
import { join, basename, resolve } from "path";

const REPORTING_PROMPT_PATH = resolve("reportingPrompt.md");
const REPORTING_GUIDELINES_PATH = resolve("reportingGuidelines.md");

export async function loadReportPromptContext() {
    const [promptText, guidelinesText] = await Promise.all([
        fs.readFile(REPORTING_PROMPT_PATH, "utf8"),
        fs.readFile(REPORTING_GUIDELINES_PATH, "utf8"),
    ]);

    return {
        promptText,
        guidelinesText,
    };
}

export function normalizeDraftConfig(repository) {
    const repoPath =
        typeof repository?.repoPath === "string" && repository.repoPath.trim()
            ? repository.repoPath.trim()
            : null;
    const provider =
        typeof repository?.reportProvider === "string" &&
        ["codex", "claude"].includes(repository.reportProvider.trim())
            ? repository.reportProvider.trim()
            : "codex";
    const auditRef =
        typeof repository?.auditRef === "string" && repository.auditRef.trim()
            ? repository.auditRef.trim()
            : null;

    return {
        repoPath,
        provider,
        auditRef,
    };
}

export async function resolveRepoPath(inputPath) {
    if (!inputPath) {
        throw new Error("Local repo path is not configured");
    }

    const resolved = await fs.realpath(resolve(inputPath));
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) {
        throw new Error("Local repo path must be a directory");
    }

    await fs.access(join(resolved, ".git"));
    return resolved;
}

export function buildDraftSourcePayload(reviewData, sourceType, sourceId) {
    if (!reviewData || !Array.isArray(reviewData.rows)) {
        throw new Error("Review data is unavailable");
    }

    if (sourceType === "group") {
        return buildGroupPayload(reviewData, sourceId);
    }

    if (sourceType === "single") {
        return buildSinglePayload(reviewData, sourceId);
    }

    throw new Error(`Unsupported draft source type: ${sourceType}`);
}

export function buildConsensusReportPlan(reviewData, reportStatuses = {}) {
    const rows = Array.isArray(reviewData?.rows) ? reviewData.rows : [];
    const commenters = Array.isArray(reviewData?.commenters) ? reviewData.commenters : [];
    const uniqueIssues = [];
    const seenGroups = new Set();
    const seenSingles = new Set();

    for (const row of rows) {
        if (row.isDuplicate && row.groupNumber) {
            if (seenGroups.has(row.groupNumber)) {
                continue;
            }

            seenGroups.add(row.groupNumber);
            const groupRows = rows.filter((entry) => entry.groupNumber === row.groupNumber);
            const primaryRow = groupRows
                .slice()
                .sort((left, right) => compareIssueNumber(left, right))[0];
            uniqueIssues.push({
                sourceType: "group",
                sourceId: row.groupNumber,
                primaryRow,
                rows: groupRows,
            });
            continue;
        }

        if (!row.isDuplicate && !seenSingles.has(row.commentUrl)) {
            seenSingles.add(row.commentUrl);
            uniqueIssues.push({
                sourceType: "single",
                sourceId: row.commentUrl,
                primaryRow: row,
                rows: [row],
            });
        }
    }

    return uniqueIssues
        .filter((issue) => shouldIncludeInConsensusReport(issue.rows, issue.primaryRow, commenters, reportStatuses))
        .map((issue) => ({
            sourceType: issue.sourceType,
            sourceId: issue.sourceId,
            issueNumber: issue.primaryRow?.issueNumber || null,
        }));
}

function buildGroupPayload(reviewData, groupNumber) {
    const members = reviewData.rows
        .filter((row) => row.groupNumber === groupNumber)
        .sort(compareIssueNumber)
        .map(buildRootCommentSource);

    if (!members.length) {
        throw new Error(`Duplicate group ${groupNumber} was not found`);
    }

    return {
        sourceType: "group",
        sourceId: groupNumber,
        titleHint: `Duplicate Group ${groupNumber}`,
        isDuplicateGroup: true,
        members,
    };
}

function buildSinglePayload(reviewData, commentUrl) {
    const row = reviewData.rows.find((entry) => entry.commentUrl === commentUrl);
    if (!row) {
        throw new Error("Finding was not found");
    }

    return {
        sourceType: "single",
        sourceId: commentUrl,
        titleHint: row.issueNumber || "Single Finding",
        isDuplicateGroup: false,
        members: [buildRootCommentSource(row)],
    };
}

function buildRootCommentSource(row) {
    return {
        issueNumber: row.issueNumber || "",
        commentUrl: row.commentUrl,
        proposer: row.proposer,
        path: row.path || null,
        line: row.line || null,
        diffSide: row.diffSide || null,
        diffHunk: row.diffHunk || null,
        commentText: row.Comment?.fullText || row.Comment?.text || "",
    };
}

function compareIssueNumber(left, right) {
    const leftParts = String(left.issueNumber || "").replace(/^D-/, "").split(".");
    const rightParts = String(right.issueNumber || "").replace(/^D-/, "").split(".");
    const leftMajor = Number.parseInt(leftParts[0], 10) || 0;
    const rightMajor = Number.parseInt(rightParts[0], 10) || 0;
    if (leftMajor !== rightMajor) {
        return leftMajor - rightMajor;
    }

    const leftMinor = Number.parseInt(leftParts[1], 10) || 0;
    const rightMinor = Number.parseInt(rightParts[1], 10) || 0;
    return leftMinor - rightMinor;
}

export function buildPrompt({ repository, source, reportContext }) {
    const repoSummary = [
        `Repository: ${repository.owner}/${repository.repo}`,
        `Pull Request: #${repository.pullRequestNumber}`,
        repository.auditRef ? `Audit ref: ${repository.auditRef}` : null,
        `Source type: ${source.sourceType}`,
        source.isDuplicateGroup
            ? `Duplicate group: ${source.sourceId}`
            : `Comment URL: ${source.sourceId}`,
    ]
        .filter(Boolean)
        .join("\n");

    const membersBlock = source.members
        .map((member, index) => {
            const header = [
                `Member ${index + 1}`,
                `Issue number: ${member.issueNumber || "N/A"}`,
                `Comment URL: ${member.commentUrl}`,
                `Proposer: ${member.proposer || "Unknown"}`,
                `Path: ${member.path || "Unknown"}`,
                `Line: ${member.line || "Unknown"}`,
            ].join("\n");

            const diffBlock = member.diffHunk
                ? `Diff hunk:\n<<<DIFF\n${member.diffHunk}\nDIFF`
                : "Diff hunk:\n<none>";

            return `${header}\n\nRoot comment text:\n<<<COMMENT\n${member.commentText}\nCOMMENT\n\n${diffBlock}`;
        })
        .join("\n\n---\n\n");

    return `
You are generating one report-ready audit finding draft from review comments.

Read the repository in the current working directory if you need code context.
Use only the root finding comments provided below. Do not use thread replies, reactions, or later discussion.

Merge rules:
- For a single finding, preserve report-ready wording as much as possible.
- For a duplicate group, merge findings when they describe the same vulnerability pattern, the same broken invariant, or the same remediation family.
- Do not require the same direct buggy line.
- Keep unique affected locations and unique evidence from each root comment.
- If the findings do not belong in one issue, return split-needed.

Reporting rules:
- Follow the reporting instructions and guidelines below.
- Keep wording simple and short.
- Prefer minimal edits over full rewrites when a source comment is already report-ready.
- For duplicate groups, choose the strongest report-ready comment as the base and add only missing evidence.
- All code references, file paths, contracts, and lines must use backticks.
- Recommendation should be a heading line with no colon.

Return only JSON that matches the output schema.

Audit context:
${repoSummary}

Report prompt:
<<<REPORT_PROMPT
${reportContext.promptText}
REPORT_PROMPT

Report guidelines:
<<<REPORT_GUIDELINES
${reportContext.guidelinesText}
REPORT_GUIDELINES

Input root comments:
${membersBlock}
`.trim();
}

export function getDraftOutputSchema() {
    return {
        type: "object",
        additionalProperties: false,
        required: [
            "mode",
            "confidence",
            "sharedBugClass",
            "sharedInvariant",
            "baseCommentUrl",
            "splitReason",
            "uniqueEvidence",
            "reportDraft",
        ],
        properties: {
            mode: {
                type: "string",
                enum: ["passthrough", "merge_exact", "merge_pattern", "split_needed"],
            },
            confidence: { type: "number" },
            sharedBugClass: { type: ["string", "null"] },
            sharedInvariant: { type: ["string", "null"] },
            baseCommentUrl: { type: ["string", "null"] },
            splitReason: { type: ["string", "null"] },
            uniqueEvidence: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["commentUrl", "path", "lines", "whyIncluded"],
                    properties: {
                        commentUrl: { type: "string" },
                        path: { type: ["string", "null"] },
                        lines: { type: ["string", "null"] },
                        whyIncluded: { type: "string" },
                    },
                },
            },
            reportDraft: {
                type: "object",
                additionalProperties: false,
                required: ["title", "severity", "body", "recommendation", "status"],
                properties: {
                    title: { type: "string" },
                    severity: {
                        type: "string",
                        enum: ["Critical", "Major", "Minor", "Informational"],
                    },
                    body: { type: "string" },
                    recommendation: { type: "string" },
                    status: {
                        type: "string",
                        enum: ["Pending", "Acknowledged", "Partially Resolved", "Resolved"],
                    },
                },
            },
        },
    };
}

export function formatReportDraftMarkdown(result) {
    const draft = result?.reportDraft;
    if (!draft) {
        throw new Error("Report draft payload is missing");
    }

    return [
        draft.title.trim(),
        `Severity: ${draft.severity}`,
        "",
        draft.body.trim(),
        "",
        "Recommendation",
        "",
        draft.recommendation.trim(),
        "",
        `Status: ${draft.status}`,
        "",
    ].join("\n");
}

export function formatWholeReportMarkdown({ repository, findings, skippedItems = [] }) {
    const header = [
        "DRAFT - NOT INTENDED TO BE SHARED",
        "",
        "Detailed Findings",
        "",
    ];

    const findingBlocks = findings.flatMap((finding, index) => {
        const draft = finding.reportDraft;
        return [
            `${index + 1}. ${draft.title.trim()}`,
            `Severity: ${draft.severity}`,
            "",
            draft.body.trim(),
            "",
            "Recommendation",
            "",
            draft.recommendation.trim(),
            "",
            `Status: ${draft.status}`,
            "",
        ];
    });

    const skippedBlock = skippedItems.length
        ? [
              "Manual Review Required",
              "",
              ...skippedItems.flatMap((item) => [
                  `- ${item.label}: ${item.reason}`,
              ]),
              "",
          ]
        : [];

    return [...header, ...findingBlocks, ...skippedBlock].join("\n");
}

export async function writeDraftArtifacts({ outputDir, fileStem, markdown, result, prompt }) {
    await fs.mkdir(outputDir, { recursive: true });

    const markdownPath = join(outputDir, `${fileStem}.md`);
    const metadataPath = join(outputDir, `${fileStem}.json`);

    await Promise.all([
        fs.writeFile(markdownPath, markdown, "utf8"),
        fs.writeFile(
            metadataPath,
            JSON.stringify(
                {
                    result,
                    prompt,
                },
                null,
                2,
            ),
            "utf8",
        ),
    ]);

    return {
        markdownPath,
        metadataPath,
    };
}

export function buildDraftFileStem({ repository, source, startedAt }) {
    const repoSlug = slugify(`${repository.owner}-${repository.repo}-pr${repository.pullRequestNumber}`);
    const sourceSlug =
        source.sourceType === "group"
            ? slugify(source.sourceId)
            : slugify(basename(source.sourceId));
    const timestamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
    return `${repoSlug}-${source.sourceType}-${sourceSlug}-${timestamp}`;
}

export function getDraftOutputDir(baseDir) {
    return join(baseDir, "report-drafts");
}

export async function writeSchemaTempFile(schema) {
    const schemaPath = join(
        os.tmpdir(),
        `audit-report-draft-schema-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    await fs.writeFile(schemaPath, JSON.stringify(schema), "utf8");
    return schemaPath;
}

export async function cleanupTempFile(filePath) {
    if (!filePath) {
        return;
    }

    try {
        await fs.unlink(filePath);
    } catch (_) {
        // ignore cleanup failures
    }
}

export function buildGoogleDocTitle({ repository, source }) {
    let label = `Issue ${source.members?.[0]?.issueNumber || "Single"}`;
    if (source.sourceType === "group") {
        label = `Duplicate ${source.sourceId}`;
    } else if (source.sourceType === "full-report") {
        label = "Full Report";
    }
    return `${repository.owner}/${repository.repo} PR #${repository.pullRequestNumber} - ${label}`;
}

function slugify(value) {
    return String(value || "draft")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

function shouldIncludeInConsensusReport(rows, primaryRow, commenters, reportStatuses) {
    const statusData = reportStatuses?.[primaryRow?.commentUrl] || {};
    const status = statusData.status || "default";
    if (status === "wont-report" || status === "partial") {
        return false;
    }

    const totalCommenters = commenters.length;
    return rows.some((row) => {
        const thumbsUpCount = row.thumbsUpCount || 0;
        return thumbsUpCount + 1 >= Math.ceil((2 / 3) * totalCommenters);
    });
}
