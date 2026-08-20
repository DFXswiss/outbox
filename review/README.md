# review/

Deterministic copy checks for Outbox. Functions in this directory are plain Node and TypeScript: they take draft text plus a `rules.json` schema and return findings.

Blocking checks cover forbidden claims, MiCAR-unsafe phrasing, and provisional numbers without a qualifier. Hints cover emoji count, sentence length, post spacing, media references, and common LLM filler.

Imports are limited to `node:`, `zod`, and other files in this directory.
