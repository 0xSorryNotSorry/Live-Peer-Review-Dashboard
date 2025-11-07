# GitHub Pull Request Review Reporter

This script generates **PDF** reports of pull request review comments and their reactions from GitHub repositories. It fetches data using the GitHub GraphQL API and processes it to create comprehensive reports that highlight reviewer feedback, reactions, and the overall sentiment of comments on specified pull requests.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
  - [1. GitHub Personal Access Token](#1-github-personal-access-token)
  - [2. Configuration File (`config.json`)](#2-configuration-file-configjson)
- [Usage](#usage)
  - [Command-Line Arguments](#command-line-arguments)
  - [Examples](#examples)
- [Output](#output)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Fetches pull request review comments and reactions** using the GitHub GraphQL API.
- Supports **multiple repositories and pull requests** specified in a configuration file.
- Generates reports in **PDF** format.
- **Highlights comments** based on the number of positive or negative reactions.
- Provides **hyperlinks** to the original comments on GitHub for easy reference.
- **Detects and tracks duplicate findings** using DUP markers in comments.
- **Assigns duplicates evenly** across auditors for reporting.
- **Groups duplicate findings** with their originals for easy review.

## Prerequisites

- **Node.js** (version 12 or higher)
- **npm** (Node Package Manager)
- A GitHub **Personal Access Token** with appropriate permissions.

## Installation

1. **Clone the Repository**

   ```bash
   git clone https://github.com/yourusername/github-pr-review-reporter.git
   cd github-pr-review-reporter
   ```

2. **Install Dependencies**

   ```bash
   npm install
   ```

## Configuration

### 1. GitHub Personal Access Token

The script requires a GitHub Personal Access Token to authenticate with the GitHub API.

- **Create a Personal Access Token:**

  1. Go to [GitHub Settings](https://github.com/settings/tokens).
  2. Click on **"Generate new token"**.
  3. Provide a description and select the following scopes:
     - `repo` (Full control of private repositories)
     - `read:org` (Read org and team membership)
  4. Click **"Generate token"** and copy the token.

- **Set Up Environment Variable:**

  Create a `.env` file in the root directory of the project and add your token:

  ```env
  GITHUB_TOKEN=your_personal_access_token_here
  ```

### 2. Configuration File (`config.json`)

Create a `config.json` file in the root directory of the project to specify the repositories and pull requests you want to process.

#### Example `config.json`

```json
{
  "name": "Review_Report",
  "repositories": [
    {
      "owner": "octocat",
      "repo": "Hello-World",
      "pullRequestNumber": 42
    },
    {
      "owner": "yourusername",
      "repo": "your-repo",
      "pullRequestNumber": 101
    }
  ]
}
```

- **Parameters:**
  - `name`: The base name for the output file (without extension).
  - `repositories`: An array of repository objects containing:
    - `owner`: GitHub username or organization name.
    - `repo`: Repository name.
    - `pullRequestNumber`: The pull request number to process.

## Usage

Run the script using Node.js, optionally specifying the configuration file path.

```bash
node main.js [--config-path=path/to/config.json]
```

### Command-Line Arguments

- `--config-path`: Specifies the path to the configuration file. Default is `./config.json`.

  ```bash
  --config-path=./config.json
  ```

### Examples

- **Generate a PDF Report Using Default Config**

  ```bash
  node main.js
  ```

- **Generate a PDF Report with Custom Config Path**

  ```bash
  node main.js --config-path=./myconfig.json
  ```

## Duplicate Detection

During the peer review phase, auditors can mark findings as duplicates using a consistent marker format in their GitHub comments:

### Marking Duplicates

To mark a finding as a duplicate, include the following marker in your comment:

```
DUP <link_to_original_finding>
```

**Supported formats:**
- `DUP https://github.com/owner/repo/pull/123#discussion_r1234567890`
- `DUP: https://github.com/owner/repo/pull/123#discussion_r1234567890`
- `DUP <https://github.com/owner/repo/pull/123#discussion_r1234567890>`

### How It Works

1. **Detection**: The tool automatically parses all review comments for DUP markers
2. **Grouping**: Duplicates are grouped with their original findings
3. **Assignment**: Each duplicate is assigned to its proposer for reporting
4. **Statistics**: Duplicate findings are excluded from the main issue statistics to avoid double-counting

### Example Workflow

1. Auditor A posts a finding about reentrancy in function X
2. Auditor B finds the same issue and comments: `DUP https://github.com/owner/repo/pull/42#discussion_r987654321` (linking to Auditor A's comment)
3. The tool will:
   - Group both findings together
   - Show Auditor A as the original proposer
   - Assign the duplicate to Auditor B for their report
   - Display the relationship in the PDF report

## Output

The script will generate a PDF file named `{name}.pdf` based on the `name` specified in your `config.json`.

### PDF Report

- **Structure:**

  - The report includes a section for each repository and pull request.
  - **Issues Summary**: Shows counts of reported, non-reported, and pending findings (excluding duplicates)
  - **Reaction Completion Stats**: Displays how many comments each reviewer has reacted to
  - **Duplicate Findings**: Groups all duplicates with their originals, showing proposers and counts
  - **Duplicate Assignments**: Shows which duplicates are assigned to each auditor for reporting
  - **All Comments Table**: Complete list with comments, reported status, duplicate markers, and reactions
  - Comments include hyperlinks to the original GitHub comments.

- **Styling:**

  - Positive feedback rows are highlighted in **green**.
  - Negative feedback rows are highlighted in **red**.
  - Duplicate markers link to the original finding.

## Workflow Integration

This tool is designed to integrate seamlessly into the Oak Security audit process:

1. **During Peer Review Phase**: 
   - Auditors review each other's findings in the GitHub PR
   - When a duplicate is identified, mark it with `DUP <link_to_original>`
   - React with 👍 (agree) or 👎 (disagree) to findings
   - React with 🚀 on resolved threads that should be reported

2. **After Peer Review**:
   - Run this tool to generate the PDF report
   - Review the duplicate groups to ensure correct identification
   - Check duplicate assignments to see which auditor reports which duplicate
   - Verify reaction completion stats to ensure all findings were reviewed

3. **Finalizing Reports**:
   - Each auditor reports their assigned findings (including assigned duplicates)
   - The lead uses the report to track coverage and ensure nothing is missed

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for improvements or feature requests.

## License

This project is licensed under the [MIT License](LICENSE).

---

**Note:** Ensure that you have the necessary permissions to access the repositories and pull requests you specify. Unauthorized access may result in errors or violations of GitHub's terms of service.
