import express from "express";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import fs from "fs/promises";
import { getPRReviewCommentsWithReactions, generatePDF } from "./dataFetcher.js";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import { normalizeResearchersConfig } from "./researchersConfig.js";
import {
    buildConsensusReportPlan,
    buildDraftFileStem,
    buildGoogleDocTitle,
    buildPrompt,
    buildDraftSourcePayload,
    formatWholeReportMarkdown,
    formatReportDraftMarkdown,
    getDraftOutputDir,
    loadReportPromptContext,
    normalizeDraftConfig,
    resolveRepoPath,
    writeDraftArtifacts,
} from "./reportDrafting.js";
import {
    createGoogleDocDraft,
    isGoogleDocsEnabled,
    runDraftWithProvider,
} from "./reportDraftProviders.js";

dotenv.config();

// Initialize Octokit for posting comments
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

// Get authenticated user (token owner)
let authenticatedUser = null;
async function getAuthenticatedUser() {
    if (!authenticatedUser) {
        try {
            const { data } = await octokit.rest.users.getAuthenticated();
            authenticatedUser = data.login;
            console.log(`🔑 Authenticated as: ${authenticatedUser}`);
        } catch (error) {
            console.error('Failed to get authenticated user:', error.message);
        }
    }
    return authenticatedUser;
}

// Fetch authenticated user on startup
getAuthenticatedUser();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// In-memory undupe flags (cleared on server restart)
const undupeFlags = {};

// In-memory cache for PR data
const prDataCache = new Map();
const CACHE_TTL = 30 * 1000; // 30 seconds
const REPORT_DRAFT_JOBS_FILE = "report-draft-jobs.json";
const runningReportDraftJobs = new Map();
let reportDraftState = null;

function getCacheKey(owner, repo, prNumber, prIndex = null) {
    // Include prIndex to support duplicate PRs with different researcher configs
    const baseKey = `${owner}/${repo}#${prNumber}`;
    return prIndex !== null ? `${baseKey}@${prIndex}` : baseKey;
}

function getCachedData(owner, repo, prNumber, prIndex = null) {
    const key = getCacheKey(owner, repo, prNumber, prIndex);
    const cached = prDataCache.get(key);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        const age = Math.round((Date.now() - cached.timestamp) / 1000);
        console.log(`📦 Serving cached data for ${key} (age: ${age}s)`);
        return cached.data;
    }

    return null;
}

function setCachedData(owner, repo, prNumber, data, prIndex = null) {
    const key = getCacheKey(owner, repo, prNumber, prIndex);
    prDataCache.set(key, {
        data: data,
        timestamp: Date.now(),
    });
    console.log(`💾 Cached data for ${key}`);
}

function invalidateCache(owner, repo, prNumber, prIndex = null) {
    const key = getCacheKey(owner, repo, prNumber, prIndex);
    prDataCache.delete(key);
    console.log(`🗑️ Cache invalidated for ${key}`);
}

function parseOptionalPrIndex(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

// Data directory for configs and app-generated files (defaults to working directory)
const DATA_DIR = process.env.APP_DATA_DIR
    ? resolve(process.env.APP_DATA_DIR)
    : process.cwd();
function dataPath(filename) {
    return join(DATA_DIR, filename);
}
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (_) {
        // ignore
    }
}

// Middleware
app.use(express.json());
app.use(
    express.static(join(__dirname, "public"), {
        setHeaders(res) {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
        },
    }),
);

// Load config
function getConfigFilePath() {
    const configFile = process.env.CONFIG_FILE
        ? resolve(process.env.CONFIG_FILE)
        : process.env.CONFIG_DIR
        ? join(resolve(process.env.CONFIG_DIR), "config.json")
        : dataPath("config.json");
    return configFile;
}

async function loadConfig() {
    try {
        const configFile = getConfigFilePath();
        const data = await fs.readFile(configFile, "utf8");
        return JSON.parse(data);
    } catch (error) {
        if (error.code === "ENOENT") {
            // File doesn't exist, return null (not an error on first run)
            return null;
        }
        console.error("Error reading config file:", error);
        return null;
    }
}

// Load researchers config for a specific PR
async function loadResearchers(owner, repo, prNumber, prIndex = null) {
    try {
        // For duplicate PRs, use index-specific config file
        let filename;
        if (prIndex !== null) {
            filename = `researchers-${owner}-${repo}-${prNumber}-idx${prIndex}.json`;
        } else {
            filename = `researchers-${owner}-${repo}-${prNumber}.json`;
        }
        
        const data = await fs.readFile(dataPath(filename), "utf8");
        return normalizeResearchersConfig(JSON.parse(data));
    } catch (error) {
        return normalizeResearchersConfig(null);
    }
}

// Load assignments
async function loadAssignments() {
    try {
        const data = await fs.readFile(dataPath("assignments.json"), "utf8");
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

// Save assignments
async function saveAssignments(assignments) {
    await ensureDataDir();
    await fs.writeFile(
        dataPath("assignments.json"),
        JSON.stringify(assignments, null, 2),
    );
}

// Save researchers config for a specific PR
async function saveResearchers(owner, repo, prNumber, researchers, prIndex = null) {
    await ensureDataDir();
    const normalizedConfig = normalizeResearchersConfig(researchers);
    // For duplicate PRs, use index-specific config file
    let filename;
    if (prIndex !== null) {
        filename = `researchers-${owner}-${repo}-${prNumber}-idx${prIndex}.json`;
    } else {
        filename = `researchers-${owner}-${repo}-${prNumber}.json`;
    }
    await fs.writeFile(dataPath(filename), JSON.stringify(normalizedConfig, null, 2));
    return normalizedConfig;
}

async function getPreparedReviewData(prIndex, { forceRefresh = false } = {}) {
    const config = await loadConfig();
    if (!config || !config.repositories || config.repositories.length === 0) {
        throw new Error("No repository configured");
    }

    if (prIndex >= config.repositories.length) {
        throw new Error("Invalid PR index");
    }

    const repo = config.repositories[prIndex];

    if (!forceRefresh) {
        const cached = getCachedData(repo.owner, repo.repo, repo.pullRequestNumber, prIndex);
        if (cached) {
            return cached;
        }
    }

    const researchersConfig = await loadResearchers(
        repo.owner,
        repo.repo,
        repo.pullRequestNumber,
        prIndex,
    );
    const assignments = await loadAssignments();
    const data = await getPRReviewCommentsWithReactions(
        repo.owner,
        repo.repo,
        repo.pullRequestNumber,
        undupeFlags,
    );

    if (researchersConfig.researchers.length > 0) {
        const allowedHandles = researchersConfig.researchers.map((r) => r.handle);
        data.rows = data.rows.filter((row) => allowedHandles.includes(row.proposer));

        const allResearchers = new Set(allowedHandles);
        data.commenters.forEach((commenter) => allResearchers.add(commenter));
        data.commenters = Array.from(allResearchers).filter((commenter) =>
            allowedHandles.includes(commenter),
        );

        allowedHandles.forEach((handle) => {
            if (!data.reactionStats[handle]) {
                let reacted = 0;
                let total = 0;
                data.rows.forEach((row) => {
                    if (row.proposer !== handle) {
                        total += 1;
                        if (row.reactions && row.reactions[handle]) {
                            reacted += 1;
                        }
                    }
                });

                const percentage = total === 0 ? 100 : Math.round((reacted / total) * 100);
                data.reactionStats[handle] = {
                    text: `${reacted}/${total} (${percentage}%)`,
                    percentage,
                };
            }
        });
    }

    data.rows = data.rows.map((row) => {
        const savedAssignment = assignments[row.Comment.hyperlink];
        let assignedTo = "";

        if (savedAssignment) {
            assignedTo = savedAssignment;
        } else if (!row.isDuplicate) {
            assignedTo = row.proposer;
        }

        return {
            ...row,
            assignedTo,
        };
    });

    const responseData = {
        ...data,
        repository: repo,
        researchersConfig,
    };

    setCachedData(repo.owner, repo.repo, repo.pullRequestNumber, responseData, prIndex);
    return responseData;
}

async function getReportDraftState() {
    if (reportDraftState) {
        return reportDraftState;
    }

    try {
        const raw = await fs.readFile(dataPath(REPORT_DRAFT_JOBS_FILE), "utf8");
        reportDraftState = JSON.parse(raw);
    } catch (error) {
        reportDraftState = { jobsBySourceKey: {} };
    }

    if (!reportDraftState.jobsBySourceKey) {
        reportDraftState.jobsBySourceKey = {};
    }

    return reportDraftState;
}

async function persistReportDraftState() {
    const state = await getReportDraftState();
    await ensureDataDir();
    await fs.writeFile(dataPath(REPORT_DRAFT_JOBS_FILE), JSON.stringify(state, null, 2));
}

function buildReportDraftSourceKey(prIndex, sourceType, sourceId) {
    return `${prIndex}:${sourceType}:${sourceId}`;
}

function buildReportDraftJobId(sourceType, sourceId) {
    const safeSource = String(sourceId).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
    return `${sourceType}-${safeSource}-${Date.now()}`;
}

function sanitizeReportDraftJob(job) {
    if (!job) {
        return null;
    }

    return {
        id: job.id,
        prIndex: job.prIndex,
        sourceType: job.sourceType,
        sourceId: job.sourceId,
        sourceKey: job.sourceKey,
        status: job.status,
        provider: job.provider,
        model: job.model,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt || null,
        error: job.error || null,
        docUrl: job.docUrl || null,
        markdownPath: job.markdownPath || null,
        markdownUrl: job.markdownPath ? `/api/report-drafts/${job.id}/markdown` : null,
        mode: job.mode || null,
        confidence: job.confidence ?? null,
        itemCount: job.itemCount ?? null,
        completedCount: job.completedCount ?? null,
        skippedCount: job.skippedCount ?? null,
    };
}

async function upsertReportDraftJob(job) {
    const state = await getReportDraftState();
    state.jobsBySourceKey[job.sourceKey] = job;
    await persistReportDraftState();
    return job;
}

async function findReportDraftJobById(jobId) {
    const state = await getReportDraftState();
    return Object.values(state.jobsBySourceKey).find((job) => job.id === jobId) || null;
}

async function listReportDraftJobs(prIndex) {
    const state = await getReportDraftState();
    return Object.values(state.jobsBySourceKey)
        .filter((job) => job.prIndex === prIndex)
        .sort(
            (left, right) =>
                new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
        )
        .map(sanitizeReportDraftJob);
}

function getProviderModel(repository, provider) {
    if (typeof repository?.reportModel === "string" && repository.reportModel.trim()) {
        return repository.reportModel.trim();
    }

    return provider === "claude" ? "sonnet" : "gpt-5.4";
}

async function generateDraftResultForSource({
    reviewData,
    repository,
    draftConfig,
    repoPath,
    sourceType,
    sourceId,
    provider,
    model,
    startedAt,
}) {
    const reportContext = await loadReportPromptContext();
    const source = buildDraftSourcePayload(reviewData, sourceType, sourceId);
    const prompt = buildPrompt({
        repository: {
            owner: repository.owner,
            repo: repository.repo,
            pullRequestNumber: repository.pullRequestNumber,
            auditRef: draftConfig.auditRef,
        },
        source,
        reportContext,
    });
    const providerResult = await runDraftWithProvider({
        provider,
        repoPath,
        prompt,
        model,
    });
    const markdown = formatReportDraftMarkdown(providerResult.structured);
    const fileStem = buildDraftFileStem({
        repository,
        source,
        startedAt,
    });
    const artifacts = await writeDraftArtifacts({
        outputDir: getDraftOutputDir(DATA_DIR),
        fileStem,
        markdown,
        result: providerResult.structured,
        prompt,
    });
    return {
        source,
        prompt,
        providerResult,
        markdown,
        artifacts,
    };
}

async function startReportDraftJob(prIndex, sourceType, sourceId, options = {}) {
    const sourceKey = buildReportDraftSourceKey(prIndex, sourceType, sourceId);
    const activeRun = runningReportDraftJobs.get(sourceKey);
    if (activeRun) {
        return activeRun.job;
    }

    const reviewData = await getPreparedReviewData(prIndex, { forceRefresh: true });
    const repository = reviewData.repository;
    const draftConfig = normalizeDraftConfig(repository);
    const repoPath = await resolveRepoPath(draftConfig.repoPath);
    const provider = draftConfig.provider;
    const model = getProviderModel(repository, provider);
    const startedAt = new Date().toISOString();
    const selectedSources = Array.isArray(options.selectedSources)
        ? options.selectedSources.filter((entry) => entry?.sourceType && entry?.sourceId)
        : [];
    const job = {
        id: buildReportDraftJobId(sourceType, sourceId),
        prIndex,
        sourceType,
        sourceId,
        sourceKey,
        status: "drafting",
        provider,
        model,
        startedAt,
        finishedAt: null,
        error: null,
        markdownPath: null,
        metadataPath: null,
        docUrl: null,
        mode: null,
        confidence: null,
        itemCount: sourceType === "full-report" ? selectedSources.length : 1,
        completedCount: 0,
        skippedCount: 0,
    };

    await upsertReportDraftJob(job);

    const promise = (async () => {
        try {
            if (sourceType === "full-report") {
                if (!selectedSources.length) {
                    throw new Error("No consensus-passed findings are ready for the full report");
                }

                const findings = [];
                const skippedItems = [];
                for (const selectedSource of selectedSources) {
                    const draftResult = await generateDraftResultForSource({
                        reviewData,
                        repository,
                        draftConfig,
                        repoPath,
                        sourceType: selectedSource.sourceType,
                        sourceId: selectedSource.sourceId,
                        provider,
                        model,
                        startedAt,
                    });

                    if (draftResult.providerResult.structured.mode === "split_needed") {
                        skippedItems.push({
                            label: selectedSource.issueNumber || selectedSource.sourceId,
                            reason:
                                draftResult.providerResult.structured.splitReason ||
                                "The selected finding needs manual split review.",
                        });
                    } else {
                        findings.push(draftResult.providerResult.structured);
                    }

                    job.completedCount += 1;
                    job.skippedCount = skippedItems.length;
                    await upsertReportDraftJob(job);
                }

                if (!findings.length) {
                    throw new Error("No findings were produced for the full report");
                }

                const markdown = formatWholeReportMarkdown({
                    repository,
                    findings,
                    skippedItems,
                });
                const fileStem = buildDraftFileStem({
                    repository,
                    source: { sourceType: "full-report", sourceId },
                    startedAt,
                });
                const artifacts = await writeDraftArtifacts({
                    outputDir: getDraftOutputDir(DATA_DIR),
                    fileStem,
                    markdown,
                    result: {
                        findings,
                        skippedItems,
                    },
                    prompt: JSON.stringify(selectedSources, null, 2),
                });
                const googleDoc = await createGoogleDocDraft({
                    title: buildGoogleDocTitle({
                        repository,
                        source: { sourceType: "full-report", sourceId },
                    }),
                    markdown,
                });

                Object.assign(job, {
                    status: "ready",
                    finishedAt: new Date().toISOString(),
                    markdownPath: artifacts.markdownPath,
                    metadataPath: artifacts.metadataPath,
                    docUrl: googleDoc?.url || null,
                    mode: "full-report",
                    confidence: null,
                });
            } else {
                const draftResult = await generateDraftResultForSource({
                    reviewData,
                    repository,
                    draftConfig,
                    repoPath,
                    sourceType,
                    sourceId,
                    provider,
                    model,
                    startedAt,
                });
                const googleDoc = await createGoogleDocDraft({
                    title: buildGoogleDocTitle({ repository, source: draftResult.source }),
                    markdown: draftResult.markdown,
                });

                Object.assign(job, {
                    status: "ready",
                    finishedAt: new Date().toISOString(),
                    markdownPath: draftResult.artifacts.markdownPath,
                    metadataPath: draftResult.artifacts.metadataPath,
                    docUrl: googleDoc?.url || null,
                    mode: draftResult.providerResult.structured.mode,
                    confidence: draftResult.providerResult.structured.confidence,
                    completedCount: 1,
                });
            }
            await upsertReportDraftJob(job);
        } catch (error) {
            Object.assign(job, {
                status: "failed",
                finishedAt: new Date().toISOString(),
                error: error.message,
            });
            await upsertReportDraftJob(job);
        } finally {
            runningReportDraftJobs.delete(sourceKey);
        }
    })();

    runningReportDraftJobs.set(sourceKey, { job, promise });
    promise.catch(() => {
        // failure is persisted in the job state above
    });

    return job;
}

// API: Get authenticated user (token owner)
app.get("/api/me", async (req, res) => {
    try {
        const user = await getAuthenticatedUser();
        res.json({ username: user });
    } catch (error) {
        console.error("Error getting authenticated user:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Get rate limit
app.get("/api/rate-limit", async (req, res) => {
    try {
        const { data } = await octokit.rest.rateLimit.get();
        const core = data.resources.core;
        const resetDate = new Date(core.reset * 1000);
        
        res.json({
            remaining: core.remaining,
            limit: core.limit,
            used: core.used,
            reset: resetDate.toISOString(),
            resetTime: resetDate.toLocaleTimeString()
        });
    } catch (error) {
        console.error("Error getting rate limit:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Get PR data
app.get("/api/data", async (req, res) => {
    try {
        const prIndex = parseInt(req.query.prIndex) || 0;
        const forceRefresh = req.query.force === "true";
        const responseData = await getPreparedReviewData(prIndex, { forceRefresh });
        res.json(responseData);
    } catch (error) {
        console.error("Error fetching data:", error);

        // Check if it's a rate limit error
        if (error.message && error.message.includes("rate limit")) {
            return res.status(429).json({
                error: "GitHub API rate limit exceeded. Please wait and try again later.",
                isRateLimit: true,
            });
        }

        res.status(500).json({ error: error.message });
    }
});

app.get("/api/report-drafts", async (req, res) => {
    try {
        const prIndex = parseInt(req.query.prIndex) || 0;
        res.json({
            jobs: await listReportDraftJobs(prIndex),
            googleDocsEnabled: isGoogleDocsEnabled(),
        });
    } catch (error) {
        console.error("Error listing report drafts:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/report-drafts", async (req, res) => {
    try {
        const prIndex = parseInt(req.body?.prIndex, 10) || 0;
        const sourceType = req.body?.sourceType;
        const sourceId = req.body?.sourceId;

        if (!sourceType || !sourceId) {
            return res.status(400).json({ error: "Missing source type or source ID" });
        }

        let selectedSources = [];
        if (sourceType === "full-report") {
            const reviewData = await getPreparedReviewData(prIndex, { forceRefresh: true });
            selectedSources = buildConsensusReportPlan(reviewData, req.body?.reportStatuses || {});
        }

        const job = await startReportDraftJob(prIndex, sourceType, sourceId, {
            selectedSources,
        });
        res.json({
            success: true,
            job: sanitizeReportDraftJob(job),
            googleDocsEnabled: isGoogleDocsEnabled(),
        });
    } catch (error) {
        console.error("Error starting report draft:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/report-drafts/:jobId", async (req, res) => {
    try {
        const job = await findReportDraftJobById(req.params.jobId);
        if (!job) {
            return res.status(404).json({ error: "Draft job not found" });
        }

        res.json({
            job: sanitizeReportDraftJob(job),
            googleDocsEnabled: isGoogleDocsEnabled(),
        });
    } catch (error) {
        console.error("Error getting report draft job:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/report-drafts/:jobId/markdown", async (req, res) => {
    try {
        const job = await findReportDraftJobById(req.params.jobId);
        if (!job || !job.markdownPath) {
            return res.status(404).json({ error: "Draft markdown not found" });
        }

        const markdown = await fs.readFile(job.markdownPath, "utf8");
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.send(markdown);
    } catch (error) {
        console.error("Error serving report draft markdown:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Get researchers for active PR
app.get("/api/researchers", async (req, res) => {
    try {
        const { owner, repo, prNumber, prIndex } = req.query;
        if (!owner || !repo || !prNumber) {
            return res.status(400).json({ error: "Missing PR info" });
        }
        const index = parseOptionalPrIndex(prIndex);
        const researchers = await loadResearchers(owner, repo, parseInt(prNumber), index);
        res.json(researchers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Update researchers for active PR
app.post("/api/researchers", async (req, res) => {
    try {
        const { owner, repo, prNumber, researchers, lsr, prIndex } = req.body;
        if (!owner || !repo || !prNumber) {
            return res.status(400).json({ error: "Missing PR info" });
        }
        if (!Array.isArray(researchers)) {
            return res.status(400).json({ error: "Researchers must be an array" });
        }

        const index = parseOptionalPrIndex(prIndex);
        const normalizedConfig = await saveResearchers(
            owner,
            repo,
            parseInt(prNumber),
            { researchers, lsr },
            index,
        );

        invalidateCache(owner, repo, parseInt(prNumber), index);

        res.json({ success: true, researchersConfig: normalizedConfig });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Update PR configuration
app.post("/api/update-pr", async (req, res) => {
    try {
        const { owner, repo, pullRequestNumber } = req.body;

        if (!owner || !repo || !pullRequestNumber) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const config = (await loadConfig()) || { repositories: [] };
        config.repositories = [
            {
                owner,
                repo,
                pullRequestNumber,
            },
        ];
        config.name = `${repo}_Review`;

        await ensureDataDir();
        const configFile = getConfigFilePath();
        await fs.writeFile(configFile, JSON.stringify(config, null, 4));
        res.json({ success: true });
    } catch (error) {
        console.error("Error updating PR config:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Save assignment
app.post("/api/save-assignment", async (req, res) => {
    try {
        const { urls, assignedTo } = req.body;

        const assignments = await loadAssignments();

        // Save assignments for all provided URLs
        urls.forEach((url) => {
            assignments[url] = assignedTo;
        });

        await saveAssignments(assignments);
        console.log(`✅ Saved assignments for ${urls.length} issue(s) to: ${assignedTo}`);
        res.json({ success: true });
    } catch (error) {
        console.error("Error saving assignment:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Undupe a finding (mark auto-duplicate as not duplicate)
app.post("/api/undupe", async (req, res) => {
    try {
        const { commentUrl, duplicateOf } = req.body;

        // Mark this relationship as unduped (in-memory only, cleared on restart)
        const key = `${commentUrl}->${duplicateOf}`;
        undupeFlags[key] = true;

        console.log(`🔓 Unduped: ${commentUrl} from ${duplicateOf}`);
        res.json({ success: true });
    } catch (error) {
        console.error("Error undupe:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Get all PRs
app.get("/api/prs", async (req, res) => {
    try {
        const config = await loadConfig();
        if (!config || !config.repositories) {
            return res.json({ repositories: [] });
        }
        res.json({ repositories: config.repositories });
    } catch (error) {
        console.error("Error getting PRs:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Add PR
app.post("/api/prs", async (req, res) => {
    try {
        const { owner, repo, pullRequestNumber, allowDuplicate } = req.body;

        if (!owner || !repo || !pullRequestNumber) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const config = (await loadConfig()) || { repositories: [], name: "Audit Review" };

        // Check if PR already exists (unless explicitly allowing duplicates)
        if (!allowDuplicate) {
            const exists = config.repositories.some(
                (r) =>
                    r.owner === owner &&
                    r.repo === repo &&
                    r.pullRequestNumber === pullRequestNumber,
            );

            if (exists) {
                return res.status(400).json({ error: "PR already exists" });
            }
        }

        config.repositories.push({ owner, repo, pullRequestNumber });
        await fs.writeFile(getConfigFilePath(), JSON.stringify(config, null, 2));

        const duplicateMsg = allowDuplicate ? " (duplicate allowed)" : "";
        console.log(`✅ Added PR: ${owner}/${repo}#${pullRequestNumber}${duplicateMsg}`);
        res.json({ success: true, repositories: config.repositories });
    } catch (error) {
        console.error("Error adding PR:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Remove PR
app.delete("/api/prs/:index", async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const config = await loadConfig();

        if (!config || !config.repositories || index >= config.repositories.length) {
            return res.status(400).json({ error: "Invalid PR index" });
        }

        const removed = config.repositories.splice(index, 1)[0];
        await fs.writeFile(getConfigFilePath(), JSON.stringify(config, null, 2));

        console.log(
            `🗑️ Removed PR: ${removed.owner}/${removed.repo}#${removed.pullRequestNumber}`,
        );
        res.json({ success: true, repositories: config.repositories });
    } catch (error) {
        console.error("Error removing PR:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Update all PRs (for custom labels)
app.put("/api/prs/update-all", async (req, res) => {
    try {
        const { repositories } = req.body;

        if (!repositories || !Array.isArray(repositories)) {
            return res.status(400).json({ error: "Invalid repositories data" });
        }

        const config = (await loadConfig()) || { repositories: [], name: "Audit Review" };
        config.repositories = repositories;

        await fs.writeFile(getConfigFilePath(), JSON.stringify(config, null, 2));

        console.log(`✅ Updated all PRs (${repositories.length} total)`);
        res.json({ success: true });
    } catch (error) {
        console.error("Error updating PRs:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Post comment to GitHub (for LSR assignments)
app.post("/api/post-comment", async (req, res) => {
    try {
        const { owner, repo, prNumber, commentUrl, body } = req.body;

        if (!owner || !repo || !prNumber || !commentUrl || !body) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // Extract comment ID from URL (e.g., #discussion_r123456)
        const match = commentUrl.match(/discussion_r(\d+)/);
        if (!match) {
            return res.status(400).json({ error: "Invalid comment URL" });
        }

        const commentId = parseInt(match[1]);

        // Post reply to the comment
        const response = await octokit.rest.pulls.createReplyForReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            comment_id: commentId,
            body,
        });

        console.log(`✅ Posted LSR assignment comment to ${owner}/${repo}#${prNumber}`);
        res.json({ success: true, commentId: response.data.id });
    } catch (error) {
        console.error("Error posting comment:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Delete comment from GitHub
app.post("/api/delete-comment", async (req, res) => {
    try {
        const { owner, repo, prNumber, commentId } = req.body;

        console.log("Delete comment request:", { owner, repo, prNumber, commentId });

        if (!owner || !repo || !prNumber || !commentId) {
            console.error("Missing fields:", { owner, repo, prNumber, commentId });
            return res
                .status(400)
                .json({
                    error: "Missing required fields",
                    received: { owner, repo, prNumber, commentId },
                });
        }

        // Delete the comment
        await octokit.rest.pulls.deleteReviewComment({
            owner,
            repo,
            comment_id: commentId,
        });

        console.log(`🗑️ Deleted comment ${commentId} from ${owner}/${repo}#${prNumber}`);
        res.json({ success: true });
    } catch (error) {
        console.error("Error deleting comment:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: Generate PDF
app.post("/api/generate-pdf", async (req, res) => {
    try {
        const config = await loadConfig();
        if (!config || !config.repositories || config.repositories.length === 0) {
            return res.status(400).json({ error: "No repository configured" });
        }

        // Get the PR index from request body (default to 0 if not provided)
        const prIndex = req.body?.prIndex ?? 0;
        
        // Get only the active PR
        const activeRepo = config.repositories[prIndex];
        if (!activeRepo) {
            return res.status(400).json({ error: "Invalid PR index" });
        }

        // Generate filename based on the active PR (without .pdf extension, generatePDF adds it)
        const fileBaseName = `${activeRepo.owner}_${activeRepo.repo}_PR${activeRepo.pullRequestNumber}`;
        const filename = `${fileBaseName}.pdf`;
        
        // Generate PDF only for the active PR
        await generatePDF([activeRepo], fileBaseName);

        // Send the PDF file as download
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

        // PDF is generated to OUTPUT_DIR or current dir; read from there
        const outputDir = process.env.OUTPUT_DIR
            ? resolve(process.env.OUTPUT_DIR)
            : process.cwd();
        const fileBuffer = await fs.readFile(join(outputDir, filename));
        res.send(fileBuffer);
    } catch (error) {
        console.error("Error generating PDF:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Audit Review Manager Dashboard`);
    console.log(`📊 Server running at http://localhost:${PORT}`);
    console.log(`\n✨ Dashboard is live and ready!\n`);
});
