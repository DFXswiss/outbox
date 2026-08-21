# review/

Deterministic copy checks for Outbox. Functions in this directory are plain Node and TypeScript: they take draft text plus a `rules.json` schema and return findings.

The Outbox submit path runs blocking checks for forbidden claims, MiCAR-unsafe phrasing, and provisional numbers without a qualifier, and hints for emoji count and sentence length.

Imports are limited to `node:`, `zod`, and other files in this directory.
