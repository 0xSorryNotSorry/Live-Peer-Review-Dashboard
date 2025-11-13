# Live Peer Review Dashboard

Single-page dashboard that ingests GitHub pull request review comments and turns them into an actionable audit triage workspace. It highlights reactions, groups duplicate findings, lets you track assignments, and exports the current state to PDF.

> Built on top of and inspired by the open-source `audit-review-manager` project by christianvari. 🫶[^1]

## Prerequisites

- Node.js 18+
- A GitHub personal access token with the `repo` and `read:user` scopes

## Installation

```bash
git clone https://github.com/0xSorryNotSorry/Live-Peer-Review-Dashboard.git
cd Live-Peer-Review-Dashboard
npm install
```

Create a `.env` file in this directory with:

```bash
GITHUB_TOKEN=your_github_token_here
```

## Docker (recommended)

Quickstart:

```bash
docker compose up -d --build
```

Then open `http://localhost:3000`.

What gets persisted:
- The app uses a named volume `live-peer-review-dashboard-data` mounted at `/data`
- Files stored there:
  - `config.json` (PR selection and report name)
  - `researchers.json` (allowlist and lead researcher)
  - `assignments.json` (saved assignments)
  - `*.pdf` exports

Set your GitHub token:
- Put `GITHUB_TOKEN=...` in a `.env` file in this repo (Compose auto-loads it)

Environment variables (overrides):
- `PORT` (default `3000`)
- `APP_DATA_DIR` (default `/data` in the container)
- `CONFIG_DIR` (default `/data`, set `CONFIG_FILE` to override exact path)
- `OUTPUT_DIR` (default `/data`, PDFs write here)
## Usage

Start the live dashboard:

```bash
npm run server
```

Open `http://localhost:3000` in your browser. The page will load even without a configured PR.

From the dashboard you can:

- Link a PR by pasting its URL or entering owner/repo/PR# and clicking **Sync**
- Manage the researcher allowlist and designate a lead researcher
- Mark duplicate findings by adding a comment reply in the GitHub review thread with the format: `DUP <full-comment-url>` 
- Assign findings and add ad-hoc columns; assignments and custom columns persist locally per PR
- Generate a PDF snapshot of the current table with **Generate PDF**

### Marking Duplicates

To mark a finding as a duplicate, **add a reply comment** in the GitHub review thread (not the original issue body) with one of these formats:

- `DUP <https://github.com/owner/repo/pull/123#discussion_r456789>`
- `dup of <https://github.com/owner/repo/pull/123#discussion_r456789>`

**Important:**
- The DUP marker must be in a **reply comment** within the thread, not the original issue body
- Use proper spacing: `DUP <url>` 
- The app scans all comments in each thread and uses the **last** DUP marker found
- Transitive duplicates are automatically grouped: if A→B and C→B, then A, B, and C all appear in the same duplicate group
- To remove a duplicate relationship, edit the GitHub comment to delete the DUP marker, then refresh the dashboard

## Reactions & Comment Filtering

- Every review row shows who reacted with `👍` or `👎`; only GitHub review reactions are counted and displayed in the reviewer's column
- A resolved thread that carries a `🚀` reaction renders as `✅` in the **Reported** column; resolved threads without the rocket appear as "not reported yet"
- Rows turn green when `👍` coverage reaches at least two thirds of reviewers, and red when `👎` reaches two thirds of the group (excluding the proposer)
- Reaction coverage only considers handles currently in the researcher allowlist; add everyone you want counted via **Manage Researchers** or clear the filter to include all commenters
- If neither threshold is met the background stays neutral, so color always reflects consensus—green for broad agreement, red for broad rejection, and default for mixed or low-signal feedback

### CLI PDF export (optional)

You can also generate a PDF from the command line:

```bash
node main.js --config-path=./config.example.json
```

Provide your own config file or use the dashboard first—the server will create `config.json` automatically when you sync a PR.

## Resetting Local State

The app stores the most recent PR configuration, researcher list, assignments, and custom columns on your machine. Delete `config.json`, `assignments.json`, `researchers.json`, or clear your browser storage if you want a completely fresh start.

[^1]: Original project: [christianvari/audit-review-manager](https://github.com/christianvari/audit-review-manager)
