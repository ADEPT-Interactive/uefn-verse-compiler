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
