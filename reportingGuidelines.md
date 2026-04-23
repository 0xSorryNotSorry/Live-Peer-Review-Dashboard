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

Do not add a `Description` header unless explicitly asked.

## Issue Structure

Every issue should contain the following:

- `Title`
  Describe the issue and its impact in one sentence.
  Example: `Usage of saturating subtraction leads to loss of user funds`

- `Severity`
  Use one of `Critical`, `Major`, `Minor`, or `Informational`.
  Use these meanings:
  - `Critical`: a serious exploitable vulnerability that can lead to loss of funds, unrecoverable locked funds, or catastrophic denial of service
  - `Major`: a vulnerability or bug that can affect correct system behavior, lead to incorrect states, or denial of service
  - `Minor`: a best-practice violation or incorrect use of primitives that may not have major current impact, but may create future security issues or inefficiencies
  - `Informational`: comments or recommendations about design decisions or optimizations that are not security-relevant

- body text
  Always include:
  1. location
  2. description
  3. impact

  Location should name the affected `function` or `message`, plus the filename and line number.
  Description should explain the defect clearly enough for the reader to understand the problem.
  Impact should explain the consequence. If there are multiple consequences, describe all of them or describe the most severe one.

- `Recommendation`
  Explain how the issue can be fixed.

## General

Report all issues that are present in the frozen audit scope, even if:

- the client already found them
- the client says they are already known
- the client says they are already fixed
- the client says they will fix them soon

The reference point is the audited commit and agreed scope.

## Severity Heuristics

- Issues that can only be caused by an admin or owner are usually `Minor`.
- Centralization issues or potential rug-pull concerns are usually `Minor`.
- Dead code is `Informational`.
- If severity needs explanation, use this wording:
  `We classify this issue as minor since ...`
- Never write:
  `We consider this a minor issue since ...`

## Formatting Rules

- Always use code formatting for code and references such as `function` names, filenames, and line numbers.
- Mention the filename followed by a colon and line number, for example `src/file.sol:123` or `src/file.sol:123-234`.
- If the filename was just mentioned, later references may use only `line 123` or `lines 123-124`.
- Do not back-tick punctuation or spaces around code.
- Function references do not contain parentheses.
- Use `in line` rather than `at line`.
- When referring to a specific contract within scope, format the contract name as code and keep the word contract plain, for example `example` contract.
- For numbered findings 10 and higher, keep a space after the number, for example `10. Title`.

## Style Rules

- Do not use colloquial abbreviations or contractions.
- Use present tense.
- Use American English spelling.
- Use simple English and short sentences.
