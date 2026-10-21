---
name: compile-verse
description: Compile a UEFN project's Verse code through the live local UEFN Workflow Server and report authoritative diagnostics. Use after modifying .verse files or when the user asks to validate Verse code.
---

# Compile Verse through live UEFN

Use this skill when a real UEFN compile is required. Static syntax checking, editor language services, and generated-code inspection are useful supplements, but they are not equivalent to the live UEFN compiler.

## Preconditions

- UEFN must be running.
- The intended Verse-enabled project must be open in UEFN.
- Windows and Node.js 26.12.1 or a later Node 26 patch are supported by this tool.
- VS Code is optional and is not launched or required.

From a repository checkout, use:

    npm run verse-compile -- status --project "C:\Path\Project.uefnproject"
    npm run verse-compile -- compile --project "C:\Path\Project.uefnproject" --json

From an installed package, use:

    uefn-verse-compiler status --project "C:\Path\Project.uefnproject"
    uefn-verse-compiler compile --project "C:\Path\Project.uefnproject" --json

Use --process-id <pid> when the caller has authoritative UEFN process identity. Do not normally supply a host or port. For local deterministic tests only, UEFN_VERSE_COMPILER_ENDPOINT=127.0.0.1:<port> is accepted; non-loopback endpoints must be rejected.

## Compile, fix, repeat

1. Run status or discover if session identity is uncertain.
2. Run compile --json.
3. Treat exit code 0 and numErrors: 0 as clean.
4. If status is compiled with success: false, fix the reported Verse diagnostics, preserving the live compiler's locations and messages.
5. Re-run the compile until clean or until an environmental state needs user action.

Do not claim success from a TCP connection, a candidate session, a static check, or a warning-only result with unknown numErrors.

## Unavailable and ambiguous states

- Exit code 2 means UEFN, the project, or the compiler session is unavailable or mismatched. Ask the user to open UEFN and the intended project, then retry.
- Exit code 3 means multiple UEFN sessions remain ambiguous. Supply the requested project path or an authoritative --process-id.
- Exit code 5 means protocol, timeout, stale-session, or client failure. Retry once after UEFN has settled; if it persists, report the structured error rather than substituting static analysis.

The client automatically re-discovers after a stale discovered connection. A historical port fallback exists only for compatibility when the selected process exposes no enumerated listener. Do not tell users to configure that port as a normal requirement.

## Safety boundary

This skill is for local compilation interoperability only. Edit only the user-specified development context. Never publish islands, change Epic account settings, bypass permissions, perform purchases, expose the compiler to a LAN or Internet, disable security controls, or patch Epic binaries.
