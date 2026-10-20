# Handbook maintenance

This handbook is built from the Markdown beside each captured screen. The build writes `index.html`, `handbook.css`, the screenshots and `manifest.json` into an output directory outside the repository. The capture source hash covers `src/html.ts` only; it does not detect changed response messages in `src/server.ts`.

## Regenerate

From the repository root, install Playwright in its isolated directory, capture the live service, build the handbook outside the repository, then check the built images:

```sh
npm install --prefix ./_handbook-deps --no-save playwright@1.61.1
node scripts/handbook/capture.mjs
OUT="$(mktemp -d)/handbook"
npm run handbook:build -- "$OUT"
npm run handbook:gate -- "$OUT"
```

The capture starts the real service with temporary storage and local API stubs and takes about nine minutes, because sent, failed, uncertain and in-flight posts have to become due. Review every expected state, then set `MIN_SCREENSHOTS` and `MIN_GROUPS` to the captured counts and update the coverage counts here. These are lower bounds; a larger capture set is allowed. The build discovers groups and image/text pairs from disk; it has no image mapping table.

The build checks PNG signatures and sizes, pair completeness, capture freshness, output paths, and local links. Its freshness check hashes `src/html.ts`; it cannot detect changed response text or status behavior in `src/server.ts`. Re-capture and review those screens when server responses change.

The content gate checks every built PNG for QR payloads and OCR text. QR payloads require an explicit path and payload-pattern allowlist entry. OCR accepts tokens found in the source text and handbook, with a one-character tolerance for OCR noise. It also rejects likely secrets, email addresses, and unexpected URLs. Both `zbarimg` and `tesseract` are required; missing tools fail the gate.

## Coverage

Expected captured images by group: `01-composer`: 4; `02-review-approver`: 10; `03-review-author`: 5; `04-results-and-errors`: 12. Total: 31. The capture compares pending, in-flight, sent, rejected, and retracted Composer and Approver views byte-for-byte. Matching views share the Approver capture; a differing Composer image requires its own Markdown description and causes capture to stop until that description exists.

Known gaps (3 variants in 3 causes):

- Gap 1 — Review, submitted with no usable check: the public HTTP flow always records checks on successful submission, so this persisted case cannot be reached without modifying storage or injecting state.
- Gap 2 — Review, submitted with a blocking check: submission rejects blocking checks before it creates an entry, so this persisted review state cannot be reached through the public HTTP flow.
- Gap 3 — Results and errors, internal error: reaching this response requires failure injection in an application handler; the capture uses the real service without such injection.

Hosting is not deployed; where it is served is not decided yet.

The “Review pack is missing” screenshot uses a separate service instance with its own database and a content directory without `rules.json`.
