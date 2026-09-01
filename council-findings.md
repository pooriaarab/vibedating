# 🧑‍⚖️ LLM Council findings

Independent per-lens reviews from council models. Treat as co-reviewer input: de-dupe, verify each claim against the code, discard false positives, and only fix confidently-real issues.

## GPT-5.6 (Codex) (via OpenRouter) — correctness lens

.jscpd.json:2 — `min-tokens` is not the jscpd config key, so a 50–99-token clone is checked using the default floor instead of the intended 100-token floor -> rename it to `"minTokens": 100`.
.jscpd.json:5 — JavaScript and JSX are scanned despite the stated TS/TSX-only scope, so duplication in a `.js` or `.jsx` file can unexpectedly fail CI -> remove `"javascript"` and `"jsx"` from `format`.
.jscpd.json:7 — Test support files such as `tests/helpers.ts` are not ignored unless their names contain `.test`/`.spec` or they live under `__tests__`, so their duplication can fail the gate despite tests being declared excluded -> add globs for the repository’s test directories, such as `"**/{test,tests}/**"`.

## Gemini 3 Pro (via OpenRouter) — performance lens

No findings.

## Kimi K3 (via OpenRouter) — security lens

No findings.

## Grok 4.5 — maintainability lens

No findings

## GPT-5.6 (scope) — scope lens

.jscpd.json:5 — The config scans JavaScript and JSX despite the PR’s stated TS/TSX-only scope, so duplicated `.js` or `.jsx` files can push CI over the 5% threshold -> remove `"javascript"` and `"jsx"` from `format`.
