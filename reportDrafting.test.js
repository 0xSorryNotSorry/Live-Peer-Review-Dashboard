import test from "node:test";
import assert from "node:assert/strict";
import {
    buildConsensusReportPlan,
    buildDraftSourcePayload,
    formatWholeReportMarkdown,
    formatReportDraftMarkdown,
    normalizeDraftConfig,
} from "./reportDrafting.js";

const sampleReviewData = {
    rows: [
        {
            issueNumber: "D-1.2",
            groupNumber: "D-1",
            isDuplicate: true,
            commentUrl: "https://github.com/example/repo/pull/1#discussion_r2",
            proposer: "bob",
            path: "contracts/B.sol",
            line: 22,
            diffSide: "RIGHT",
            diffHunk: "@@ -1,1 +1,1 @@",
            thumbsUpCount: 2,
            Comment: {
                text: "Second duplicate",
                fullText: "Second duplicate full text",
            },
        },
        {
            issueNumber: "D-1.1",
            groupNumber: "D-1",
            isDuplicate: true,
            commentUrl: "https://github.com/example/repo/pull/1#discussion_r1",
            proposer: "alice",
            path: "contracts/A.sol",
            line: 11,
            diffSide: "RIGHT",
            diffHunk: "@@ -2,2 +2,2 @@",
            thumbsUpCount: 2,
            Comment: {
                text: "First duplicate",
                fullText: "First duplicate full text",
            },
        },
        {
            issueNumber: "7",
            isDuplicate: false,
            commentUrl: "https://github.com/example/repo/pull/1#discussion_r7",
            proposer: "carol",
            path: "contracts/C.sol",
            line: 77,
            diffSide: "RIGHT",
            diffHunk: "@@ -3,3 +3,3 @@",
            thumbsUpCount: 0,
            Comment: {
                text: "Standalone finding",
                fullText: "Standalone finding full text",
            },
        },
    ],
    commenters: ["alice", "bob", "carol"],
};

test("buildDraftSourcePayload returns sorted root comment members for duplicate groups", () => {
    const payload = buildDraftSourcePayload(sampleReviewData, "group", "D-1");

    assert.equal(payload.sourceType, "group");
    assert.equal(payload.members.length, 2);
    assert.equal(payload.members[0].issueNumber, "D-1.1");
    assert.equal(payload.members[1].issueNumber, "D-1.2");
    assert.equal(payload.members[0].commentText, "First duplicate full text");
});

test("buildDraftSourcePayload supports single findings without replies", () => {
    const payload = buildDraftSourcePayload(
        sampleReviewData,
        "single",
        "https://github.com/example/repo/pull/1#discussion_r7",
    );

    assert.equal(payload.sourceType, "single");
    assert.equal(payload.members.length, 1);
    assert.equal(payload.members[0].issueNumber, "7");
    assert.equal(payload.members[0].commentText, "Standalone finding full text");
});

test("normalizeDraftConfig keeps supported provider values and strips empty fields", () => {
    assert.deepEqual(
        normalizeDraftConfig({
            repoPath: " /tmp/repo ",
            reportProvider: "claude",
            auditRef: " abc123 ",
        }),
        {
            repoPath: "/tmp/repo",
            provider: "claude",
            auditRef: "abc123",
        },
    );

    assert.deepEqual(normalizeDraftConfig({}), {
        repoPath: null,
        provider: "codex",
        auditRef: null,
    });
});

test("formatReportDraftMarkdown keeps report field order", () => {
    const markdown = formatReportDraftMarkdown({
        reportDraft: {
            title: "Repeated validation bug allows inconsistent state",
            severity: "Major",
            body: "The issue appears in `contracts/A.sol:11` and `contracts/B.sol:22`.",
            recommendation: "Apply the validation in every affected entry point.",
            status: "Pending",
        },
    });

    assert.equal(
        markdown,
        [
            "Repeated validation bug allows inconsistent state",
            "Severity: Major",
            "",
            "The issue appears in `contracts/A.sol:11` and `contracts/B.sol:22`.",
            "",
            "Recommendation",
            "",
            "Apply the validation in every affected entry point.",
            "",
            "Status: Pending",
            "",
        ].join("\n"),
    );
});

test("buildConsensusReportPlan keeps only green consensus issues that are not excluded", () => {
    const plan = buildConsensusReportPlan(sampleReviewData, {
        "https://github.com/example/repo/pull/1#discussion_r7": { status: "wont-report" },
    });

    assert.deepEqual(plan, [
        {
            sourceType: "group",
            sourceId: "D-1",
            issueNumber: "D-1.1",
        },
    ]);
});

test("formatWholeReportMarkdown renders numbered findings and manual review notes", () => {
    const markdown = formatWholeReportMarkdown({
        repository: {
            owner: "example",
            repo: "repo",
            pullRequestNumber: 1,
        },
        findings: [
            {
                reportDraft: {
                    title: "Validation bug allows inconsistent state",
                    severity: "Major",
                    body: "The issue appears in `contracts/A.sol:11`.",
                    recommendation: "Apply validation before state changes.",
                    status: "Pending",
                },
            },
        ],
        skippedItems: [
            {
                label: "D-3",
                reason: "The duplicate group needs manual split review.",
            },
        ],
    });

    assert.match(markdown, /DRAFT - NOT INTENDED TO BE SHARED/);
    assert.match(markdown, /1\. Validation bug allows inconsistent state/);
    assert.match(markdown, /Manual Review Required/);
    assert.match(markdown, /D-3: The duplicate group needs manual split review\./);
});
