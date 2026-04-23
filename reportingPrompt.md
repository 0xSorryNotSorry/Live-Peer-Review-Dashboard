# Report Drafting Prompt

Use this prompt to turn raw audit notes into one report-ready finding entry.
Keep the writing short, clear, factual, and mechanically compliant with the reporting rules.
Use very simple English. Use short sentences. Avoid fancy words.

Read `reportingGuidelines.md` before drafting or reviewing output.

## When To Use

Use this prompt when you need to:
- rewrite a raw GitHub note, draft comment, or review note into one report issue
- normalize an existing finding into the required structure and style
- review a drafted finding for formatting and severity compliance

Do not use this prompt for generic summaries, blog posts, or non-report formats.

## Workflow

1. Extract the facts first.
   Identify the exact `function`, `message`, `contract`, filename, line span, trust boundary, exploit preconditions, worst credible impact, and remediation path.

2. Validate the evidence.
   If the exact location or behavior is unclear, derive it from the repo or say that the location is uncertain.
   Do not invent file paths, line numbers, severity, or impact.

3. Classify the issue.
   Choose one severity from `Critical`, `Major`, `Minor`, or `Informational`.
   Apply the severity heuristics from `reportingGuidelines.md` before choosing.

4. Draft in report order.
   Return the fields in this exact order: title line, `Severity: ...`, body text, `Recommendation`, and `Status: ...`.
   Ensure the body covers location, description, and impact.
   If there is a clear scenario or example, describe it directly in the body.
   Do not mention PoC files or test file names unless explicitly asked.
   If there are multiple impacts, list all material impacts or at least the most severe one.

5. Run the compliance pass.
   Check the structure, code formatting, tense, spelling, and severity wording before returning the final text.

## Output Contract

Return one issue in this order:

- plain title line with no `Title:` label
- `Severity:` one of `Critical`, `Major`, `Minor`, or `Informational`
- body text immediately after severity, with no `Description` header
- `Recommendation` as a heading line
- `Status:` one of `Pending`, `Acknowledged`, `Partially Resolved`, or `Resolved`

## Required Checks

- The title is fewer than 20 words and uses present tense.
- The title states both the defect and its impact.
- The output includes the title line, then exactly these labels: `Severity`, `Recommendation`, `Status`.
- The body text includes the exact location, a clear description, and the impact.
- The issue is still reported even if it is already known, already fixed later, or planned to be fixed later in the audited codebase.
- All code references, filenames, functions, contracts, and line references use backticks.
- Function references do not include parentheses.
- Repeated line references use `in line` or `in lines`, never `at line`.
- The text uses American English, present tense, and no contractions.
- The tone stays factual and simple.
- Use very simple English and short sentences.
- Describe examples directly. Do not say "the PoC shows" or cite test files unless asked.
