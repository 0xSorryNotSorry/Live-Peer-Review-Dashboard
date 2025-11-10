# Audit Review Manager

Single-page dashboard that ingests GitHub pull-request review comments and turns them into an actionable audit triage workspace. It highlights reactions, groups duplicate findings, lets you track assignments, and exports the current state to PDF.

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

## Usage

Start the live dashboard:

```bash
npm run server
```

Open `http://localhost:3000` in your browser. The page will load even without a configured PR.

From the dashboard you can:

- Link a PR by pasting its URL or entering owner/repo/PR# and clicking **Sync**
- Manage the researcher allowlist and designate a lead researcher
- Detect duplicate findings by using ``` DUP `<comment-link>` ```markers in GitHub review comments
- Assign findings and add ad-hoc columns; assignments and custom columns persist locally per PR
- Generate a PDF snapshot of the current table with **Generate PDF**

## Reactions & Comment Filtering

- Every review row shows who reacted with `👍` or `👎`; only GitHub review reactions are counted and displayed in the reviewer’s column.
- A resolved thread that carries a `🚀` reaction renders as `✅` in the **Reported** column; resolved threads without the rocket appear as “not reported yet.”
- Duplicate groups rely on the `DUP <link>` marker in the comment body. Auto-flagged duplicates can be removed from the table with the **Undupe** button (the flag resets when the server restarts).
- Rows turn green when `👍` coverage reaches at least two thirds of reviewers, and red when `👎` reaches two thirds of the group (excluding the proposer).

### CLI PDF export (optional)

You can also generate a PDF from the command line:

```bash
node main.js --config-path=./config.example.json
```

Provide your own config file or use the dashboard first—the server will create `config.json` automatically when you sync a PR.

## Resetting Local State

The app stores the most recent PR configuration, researcher list, assignments, and custom columns on your machine. Delete `config.json`, `assignments.json`, `researchers.json`, or clear your browser storage if you want a completely fresh start.

[^1]: Original project: [christianvari/audit-review-manager](https://github.com/christianvari/audit-review-manager)
