# Live Peer Review Dashboard

A real-time dashboard for managing security audit reviews. Turn GitHub PR comments into an organized workspace with duplicate detection, progress tracking, and team coordination features.

> Built with ❤️ on top of [christianvari/audit-review-manager](https://github.com/christianvari/audit-review-manager) 🫶

## Quick Start

**Prerequisites:**
- Node.js 18 or higher
- GitHub personal access token with `repo` and `read:user` scopes

**Install:**
```bash
git clone https://github.com/0xSorryNotSorry/Live-Peer-Review-Dashboard.git
cd Live-Peer-Review-Dashboard
npm install
```

**Configure:**
Create a `.env` file:
```bash
GITHUB_TOKEN=your_github_token_here
```

**Run:**
```bash
npm run server
```

Open http://localhost:3000 in your browser.

---

## Docker Setup (Recommended for Production)

**Quick start:**
```bash
docker compose up -d --build
```

**What gets saved:**
- PR configurations
- Researcher lists (per-PR)
- Assignments
- PDF exports

Everything persists in a Docker volume named `live-peer-review-dashboard-data`.

**Environment variables:**
- `PORT` - Server port (default: 3000)
- `APP_DATA_DIR` - Data storage location (default: `/data` in container)
- `GITHUB_TOKEN` - Your GitHub token (required)

---

## Core Features

<details>
<summary><b>Multi-PR Management</b></summary>

### Managing Multiple PRs

**Add a PR:**
1. Paste GitHub PR URL in the top input, or
2. Enter owner/repo/PR# manually
3. Click "Sync"

**Switch between PRs:**
- Click PR tabs at the top
- Each PR has independent settings
- Dashboard remembers which PR you were viewing

**Customize tab names:**
- Double-click any tab
- Enter a custom label (e.g., "X Audit")
- Default shows: `repo#123`

**Manage PRs:**
- Click "⚙️ Manage PRs" button
- Add PRs via URL or manual input
- Remove PRs you no longer need

</details>

<details>
<summary><b>Duplicate Detection</b></summary>

### How to Mark Duplicates

Add a reply comment to any thread in GitHub:
```
DUP <https://github.com/owner/repo/pull/123#discussion_r456789>
```

Or use the short format:
```
dup of #discussion_r456789
```

**Rules:**
- Must be a **reply comment** (not the original issue)
- App scans all replies in each thread
- Last DUP marker wins if multiple exist
- Transitive grouping: If A→B and C→B, then A, B, C are one group

**Remove duplicates:**
- Edit the GitHub comment to delete the DUP marker
- Refresh the dashboard

**In the dashboard:**
- Duplicate groups show as D-1, D-2, etc.
- Click group header to collapse/expand
- First duplicate (D-X.1) stays visible when collapsed

</details>

<details>
<summary><b>Researcher Management</b></summary>

### Setting Up Your Team

**Add researchers:**
1. Click "👥 Manage Researchers"
2. Enter GitHub handle
3. Click "Add"

**Set Lead Security Researcher (LSR):**
- Click "Set as LSR" next to a researcher
- LSR gets special permissions (PIC assignments)

**Per-PR researchers:**
- Each PR can have different researchers
- Switch PR tabs to see that PR's team
- Completely independent configurations

**Filtering:**
- Only shows issues from configured researchers
- Add everyone you want to see
- Or clear the list to see all issues

</details>

<details>
<summary><b>Reactions & Progress Tracking</b></summary>

### How Reactions Work

**Supported emojis:**
- 👍 Thumbs up (approve)
- 👎 Thumbs down (reject)
- 👀 Eyes (reviewed, neutral)
- 🚀 Rocket (reported - thread must be resolved)

**Row colors:**
- **Green**: 2/3+ of team gave 👍
- **Red**: 2/3+ of team gave 👎
- **White**: No consensus yet

**Progress cards:**

**Review Progress (green pie chart):**
- Shows: Issues reviewed (green or red rows)
- Formula: Reviewed / Reviewable issues
- Excludes from denominator: Won't Report, Partial
- Why: Issues marked "Won't Report" don't need review

**Reporting Progress (blue pie chart):**
- Shows: Green issues with 🚀 emoji (resolved threads only)
- Formula: Reported / Green issues
- Excludes from denominator: Red issues, Won't Report, Partial
- Why: Only counts issues that will actually be reported

**Reaction Completion Stats:**
- Shows each researcher's completion percentage
- Counts 👍, 👎, and 👀 as "reviewed"
- Formula: Reacted / Total comments (excluding own)

**Stats Cards:**
- **Reported ✅**: Green issues with 🚀 (resolved + approved)
- **Non-Reported ❌**: Resolved issues without 🚀 or red issues
- **Pending**: Unresolved issues still being discussed
- All exclude Won't Report and Partial from counts

</details>

<details>
<summary><b>Issue Status Management</b></summary>

### Won't Report & Partial Issues

**Status dropdown in "Reported" column:**
- **—** (default): Normal flow, needs 👍 majority + 🚀
- **Won't Report**: Excluded from reporting (false positive, etc.)
- **Partial**: Merged into another issue

**Partial issues:**
- Select "Partial" from dropdown
- Enter issue number (e.g., `#10`)
- Red border if left empty
- Tracks which issue covers this finding

**Effect on progress:**
- Won't Report and Partial excluded from reporting denominator
- Helps reach 100% when some issues aren't reportable

</details>

<details>
<summary><b>LSR Assignment System</b></summary>

### Assigning PIC of Reporting (LSR Only)

**For duplicate groups:**
1. Find the 👑 button in "Assigned To" column (appears on primary duplicate in each group to coordinate reporting and ensure balanced coverage)
2. Click to open assignment modal
3. Select one or more SRs (checkboxes)
4. Add optional guidance
5. Click "Post Assignment"

**What happens:**
- Posts comment to GitHub: `PIC of reporting: Alice, Bob`
- With guidance: Adds your notes below
- Shows in "Assigned To" for entire group
- Everyone gets GitHub notification

**Edit/Remove:**
- ✏️ Edit: Deletes old comment, opens modal
- 🗑️ Remove: Deletes the GitHub comment

</details>

<details>
<summary><b>Notifications</b></summary>

### Real-Time Activity Tracking

**Notification types:**
- 💬 Comments: "Alice commented on #5"
- 👍 Reactions: "Bob reacted with 👍"
- ✅ Resolutions: "Thread #7 was resolved"

**Notification panel:**
- Click 🔔 button to open
- Shows all activity chronologically
- Click notification to scroll to that issue
- Unread (yellow) → Read (gray)

**Controls:**
- ✓ Mark All Read
- ↻ Mark All Unread
- Badge shows unread count only

**Per-PR tracking:**
- Each PR has independent notifications
- Persists across sessions

</details>

<details>
<summary><b>Table Features</b></summary>

### Working with the Table

**Collapsible threads with code context:**
- Click "▶ Details" or "▶ X replies" to expand
- **ALL comments** are expandable (not just those with replies)
- See full comment text with markdown formatting
- **Code snippets** with syntax highlighting:
  - Shows exact lines from repo (e.g., lines 112-115)
  - File path displayed
  - Solidity/JavaScript syntax coloring
  - Clean code without diff markers (+/-)
- **Inline code blocks** in comments also highlighted
- Chat-style UI with timestamps
- **Collapse state persists** across page refreshes

**Bulk collapse/expand:**
- Click purple 📦 button (floating, bottom-right)
- Toggle ALL comment details at once

**Clickable duplicate group links:**
- Click group number (e.g., "D-1") in duplicate cell
- Jumps to that group's section in table
- Also works in Duplicate Findings summary table

**Filtering:**
- **Proposer**: Show issues from specific researcher
  - **"Not Me"**: Filter out your own issues (shows only others' findings)
  - Uses GitHub token owner as "me" (automatically detected)
- **Review Status**: Reviewed (Green/Red) / Not Reviewed / All
- **Resolution**: Resolved / Not Resolved / All
- **Reported**: Has 🚀 / No 🚀 / All
- Click "Clear Filters" to reset

**Custom columns:**
- Click "➕ Add Column" for custom fields
- Double-click column header to rename
- Data persists per-PR
- Click "➖ Remove Column" to delete last column

**Assignments:**
- Type in "Assigned To" column
- Auto-saves on blur
- Duplicate groups sync assignments

**Collapsible duplicate groups:**
- Click group header to collapse/expand
- First duplicate stays visible when collapsed
- Blue separator when collapsed
- Collapse state persists across refreshes

</details>

<details>
<summary><b>Refresh & Caching</b></summary>

### Keeping Data Fresh

**Refresh options:**
- **🔄 Refresh Now**: Uses 30-second cache (saves API calls)
- **⚡ Force Refresh**: Bypasses cache (always latest)
- **Auto-refresh**: 1min / 5min / 10min intervals (default: Manual)
  - ⚠️ **Note:** Auto-refresh consumes GitHub API rate limit faster. Use Manual mode and refresh when needed to conserve API calls.

**Floating refresh button:**
- Drag anywhere on screen
- Click: Regular refresh
- Shift+Click: Force refresh
- Shows "Shift = ⚡" hint

**Caching:**
- 30-second server-side cache per PR
- Reduces GitHub API usage by ~70%
- Fresh enough for active reviews
- Force refresh when you need absolute latest

**Floating buttons:**
- **🔄 Refresh**: Drag anywhere, click to refresh, Shift+Click for force refresh
- **⬆️ Go to Top**: Appears when scrolling, smooth scroll to top
- **📦 Collapse All**: Toggle all comment details open/closed
- **🔔 Notifications**: View activity feed

</details>

<details>
<summary><b>PDF Export</b></summary>

### Generating Reports

**From dashboard:**
- Click "📄 Generate PDF"
- Downloads current state as PDF
- Includes all visible data

**From command line:**
```bash
node main.js --config-path=./config.json
```

**What's included:**
- All comments and reactions
- Duplicate groups
- Reaction completion stats
- Assignments

</details>

---

## Tips & Tricks

**Keyboard shortcuts:**
- `Shift + Click` floating refresh = Force refresh
- Double-click PR tab = Rename tab
- Double-click column header = Rename column

**UI shortcuts:**
- Click 📦 button = Collapse/expand all comments
- Click group number (D-1) = Jump to that duplicate group
- Click ▶ Details = Expand comment with code context

**Best practices:**
- Configure researchers per PR for accurate filtering
- Use "Won't Report" for false positives
- Use "Partial" for findings merged into other issues
- Mark duplicates early to reduce clutter
- Set LSR for team coordination

**Troubleshooting:**
- Not seeing updates? Click "⚡ Force Refresh"
- Wrong PR showing? Check active tab at top
- Missing researchers? Configure them per PR

---

## Local Development

**Start server:**
```bash
npm run server
```

**Stop server:**
```bash
pkill -f "node server.js"
```

**View logs:**
```bash
tail -f server.log
```

**Data storage:**
- `config.json` - PR configurations
- `researchers-{owner}-{repo}-{pr}.json` - Per-PR researchers
- `assignments.json` - Issue assignments
- `*.pdf` - Generated reports

**Clear data:**
Delete the JSON files or clear browser localStorage.

---

## Architecture

**Frontend:**
- Single-page app (vanilla JavaScript)
- Real-time updates via polling
- Per-PR state management (localStorage)
- Responsive design with dark mode

**Backend:**
- Express.js server
- GitHub GraphQL + REST API
- 30-second caching layer
- Puppeteer for PDF generation

**Features:**
- Multi-PR support with tabs
- Collapsible duplicate groups with persistent state
- Thread conversation view with code context
- Syntax-highlighted code snippets (Solidity, JS)
- Exact repo line numbers in code blocks
- Smart notifications
- LSR assignment system
- Table filtering
- Progress tracking
- Bulk collapse/expand all comments
- Clickable duplicate group navigation

---

## Contributing

Issues and PRs welcome! This is an active project used in real security audits.

---

## License

MIT License - See LICENSE file

---

[^1]: Original project: [christianvari/audit-review-manager](https://github.com/christianvari/audit-review-manager) ↩

