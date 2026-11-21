# Contributing

## Setup

Use Windows and Node.js 26.12.1 or a later Node 26 patch.

    npm ci
    npm run check

## Changes and tests

Keep the library independent of application-specific UI, storefronts, entitlement generation, and renderer state. Add generic mocked tests for protocol or discovery changes. Windows process/listener behavior must remain injectable through CompilerDiscoverySystem so CI never requires UEFN.

Protocol compatibility cases should use hand-authored sanitized fixtures. Remove usernames, absolute machine paths, IDs, tokens, cookies, and account data. Never commit Epic binaries, Verse.vsix, verse-lsp.exe, Epic extension source, Fortnite assets, UEFN assets, or copied proprietary implementation code.

Changes to the compiler request or discovery algorithm should include a live validation note when possible: UEFN open, intended project loaded, clean compile, authoritative error response, and stale/restart behavior where relevant. Live validation supplements, but does not replace, deterministic tests.

## Style

Use strict TypeScript, small public APIs, and concise TSDoc for exported behavior. Keep the loopback-only boundary intact. Do not add a fixed-port requirement or claim Linux/macOS runtime support without implementing and validating a platform strategy.

## CI policy

CI is the final check, not a linter.

- Run `npm run check` locally before pushing.
- Open pull requests as drafts. Drafts run no CI, so push to them as often as you like. Mark the pull request ready once, when it is finished; that runs CI once.
- Batch review fixes into one push. Each push to a ready pull request runs CI again and cancels the run before it.
- What runs when: drafts run nothing; ready pull requests and pushes to `main` run the build, tests, package check and audit.
- To check a draft or another branch, run CI by hand: Actions > CI > Run workflow, or `gh workflow run ci.yml --ref <branch>`.
