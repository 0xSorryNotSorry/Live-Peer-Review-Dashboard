# Reporting Guidelines

## Local Output Structure

Return findings in this order:

- plain title line with no `Title:` label
- `Severity: ...`
- blank line
- description paragraphs
- blank line
- `Recommendation`
- blank line
- recommendation paragraph
- blank line
- `Status: ...`

## Issue Structure

Every issue should contain the following:

- `Title`
  Describe the issue and its impact in one sentence.

- `Severity`
  Use one of `Critical`, `Major`, `Minor`, or `Informational`.
  Suggested meaning:
  - `Critical`: exploitable issue that can lead to loss of funds, unrecoverable locked funds, or catastrophic denial of service
  - `Major`: issue that can break correct behavior, create incorrect states, or cause denial of service
  - `Minor`: best-practice violation or weaker security property that may become more serious later
  - `Informational`: design comments or optimizations without direct security impact

- body text
  Always include:
  1. location
  2. description
  3. impact

- `Recommendation`
  Explain how the issue can be fixed.

## Formatting Rules

- Always use code formatting for code and references such as `function` names, filenames, and line numbers.
- Mention the filename followed by a colon and line number, for example `src/file.sol:123`.
- Function references do not contain parentheses.
- Use `in line` rather than `at line`.
- Use simple English and short sentences.
