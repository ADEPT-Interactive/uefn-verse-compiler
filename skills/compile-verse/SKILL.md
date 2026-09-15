---
name: compile-verse
description: Check or compile a UEFN project's Verse code. Use the installed Epic Verse language server for fast semantic diagnostics, and use the live local UEFN Workflow Server when authoritative compilation is required.
---

# Check or compile Verse

Use `check` for fast semantic diagnostics from the installed Epic language server. Use `compile` when a real UEFN build result is required. Semantic checking, editor language services, and generated-code inspection are useful supplements, but they are not equivalent to the live UEFN compiler.

## Preconditions

- Windows and Node.js 22.12.0 or a later Node 22 release below 25 are supported by this tool.
- VS Code is optional and is not launched or required.

For `compile`:

- UEFN must be running.
- The intended Verse-enabled project must be open in UEFN.

For `check`:

- The Epic `verse-lsp.exe` must be installed or supplied through `--lsp-path` / `UEFN_VERSE_LSP_PATH`.
- The project descriptor and UEFN-generated `.vproject`/digest metadata must be readable.
- UEFN and VS Code are not launched by the command. A successful check is semantic only and is not an authoritative build.

From a repository checkout, use:

    npm run verse-compile -- status --project "C:\Path\Project.uefnproject"
    npm run verse-compile -- compile --project "C:\Path\Project.uefnproject" --json
    npm run verse-compile -- check --project "C:\Path\Project.uefnproject" --json
    npm run verse-compile -- check --project "C:\Path\Project.uefnproject" --diagnostic-mode workspace --json

From an installed package, use:

    uefn-verse-compiler status --project "C:\Path\Project.uefnproject"
    uefn-verse-compiler compile --project "C:\Path\Project.uefnproject" --json
    uefn-verse-compiler check --project "C:\Path\Project.uefnproject" --json

Use --process-id <pid> when the caller has authoritative UEFN process identity. Do not normally supply a host or port. For local deterministic tests only, UEFN_VERSE_COMPILER_ENDPOINT=127.0.0.1:<port> is accepted; non-loopback endpoints must be rejected.

## Check, compile, fix, repeat

1. Run `check --json` for quick semantic feedback when generated metadata and the Epic language server are available.
2. Treat `checked-clean` as a clean semantic result only; it does not prove an authoritative UEFN build.
3. When an authoritative result is needed, run `status` or `discover` and then `compile --json`.
4. Treat exit code 0 and `numErrors: 0` from `compile` as clean.
5. If the compile status is `compiled` with `success: false`, fix the reported live diagnostics and repeat until clean or until an environmental state needs user action.

Do not claim success from a TCP connection, a candidate session, a static check, or a warning-only result with unknown numErrors.

## Unavailable and ambiguous states

- Exit code 2 means UEFN, the project, or the compiler session is unavailable or mismatched. Ask the user to open UEFN and the intended project, then retry.
- Exit code 3 means multiple UEFN sessions remain ambiguous. Supply the requested project path or an authoritative --process-id.
- Exit code 5 means protocol, timeout, stale-session, or client failure. Retry once after UEFN has settled; if it persists, report the structured error rather than substituting static analysis.

For `check`, exit code 1 means source semantic errors. Exit code 2 means an unrecognized project, unavailable language server, unavailable metadata, or an explicit workspace audit classified generated metadata as invalid. Default push-mode metadata diagnostics are retained separately with `metadataHealth: unverified` and do not by themselves change a source-clean check to exit code 2. Exit code 5 means a language-server client/protocol failure. Do not translate a `check` result into `compiled`.

The client automatically re-discovers after a stale discovered connection. A historical port fallback exists only for compatibility when the selected process exposes no enumerated listener. Do not tell users to configure that port as a normal requirement.

## Safety boundary

This skill is for local compilation interoperability only. Edit only the user-specified development context. Never publish islands, change Epic account settings, bypass permissions, perform purchases, expose the compiler to a LAN or Internet, disable security controls, or patch Epic binaries.
