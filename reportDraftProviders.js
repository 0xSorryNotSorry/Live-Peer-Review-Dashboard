import fs from "fs/promises";
import { spawn } from "child_process";
import { google } from "googleapis";
import {
    cleanupTempFile,
    getDraftOutputSchema,
    writeSchemaTempFile,
} from "./reportDrafting.js";

export async function runDraftWithProvider({
    provider,
    repoPath,
    prompt,
    model,
}) {
    if (provider === "claude") {
        return runClaudeDraft({ repoPath, prompt, model });
    }

    return runCodexDraft({ repoPath, prompt, model });
}

async function runCodexDraft({ repoPath, prompt, model }) {
    const schemaPath = await writeSchemaTempFile(getDraftOutputSchema());
    const outputPath = await writeSchemaTempFile({});

    const args = [
        "exec",
        "--skip-git-repo-check",
        "--cd",
        repoPath,
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "-o",
        outputPath,
        "--color",
        "never",
        "-",
    ];

    if (model) {
        args.splice(1, 0, "--model", model);
    }

    try {
        const { stdout, stderr } = await spawnWithInput("codex", args, prompt, { cwd: repoPath });
        const outputText = await fs.readFile(outputPath, "utf8");
        return {
            structured: JSON.parse(outputText),
            rawStdout: stdout,
            rawStderr: stderr,
        };
    } finally {
        await Promise.all([cleanupTempFile(schemaPath), cleanupTempFile(outputPath)]);
    }
}

async function runClaudeDraft({ repoPath, prompt, model }) {
    const schema = JSON.stringify(getDraftOutputSchema());
    const args = [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--json-schema",
        schema,
    ];

    if (model) {
        args.push("--model", model);
    } else {
        args.push("--model", "sonnet");
    }

    const { stdout, stderr } = await spawnWithInput("claude", args, prompt, { cwd: repoPath });
    const parsed = JSON.parse(stdout);
    return {
        structured: parsed.structured_output,
        rawStdout: stdout,
        rawStderr: stderr,
    };
}

async function spawnWithInput(command, args, input, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (error) => {
            reject(error);
        });

        child.on("close", (code) => {
            if (code !== 0) {
                reject(
                    new Error(
                        `${command} exited with code ${code}${
                            stderr ? `: ${stderr.trim()}` : ""
                        }`,
                    ),
                );
                return;
            }

            resolve({ stdout, stderr });
        });

        child.stdin.write(input);
        child.stdin.end();
    });
}

export function isGoogleDocsEnabled() {
    return !!(
        process.env.GOOGLE_DRIVE_FOLDER_ID &&
        (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE)
    );
}

export async function createGoogleDocDraft({ title, markdown }) {
    if (!isGoogleDocsEnabled()) {
        return null;
    }

    const auth = await createGoogleAuth();
    const docs = google.docs({ version: "v1", auth });
    const drive = google.drive({ version: "v3", auth });

    const createResponse = await docs.documents.create({
        requestBody: {
            title,
        },
    });

    const documentId = createResponse.data.documentId;
    if (!documentId) {
        throw new Error("Google Docs did not return a document ID");
    }

    await docs.documents.batchUpdate({
        documentId,
        requestBody: {
            requests: [
                {
                    insertText: {
                        location: { index: 1 },
                        text: markdown,
                    },
                },
            ],
        },
    });

    if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
        const fileMeta = await drive.files.get({
            fileId: documentId,
            fields: "parents",
        });

        const previousParents = (fileMeta.data.parents || []).join(",");
        await drive.files.update({
            fileId: documentId,
            addParents: process.env.GOOGLE_DRIVE_FOLDER_ID,
            removeParents: previousParents || undefined,
            fields: "id, parents",
        });
    }

    return {
        documentId,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
    };
}

async function createGoogleAuth() {
    const scopes = [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive",
    ];

    if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
        return new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
            scopes,
        }).getClient();
    }

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (credentials.private_key) {
        credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    }

    return new google.auth.GoogleAuth({
        credentials,
        scopes,
    }).getClient();
}
