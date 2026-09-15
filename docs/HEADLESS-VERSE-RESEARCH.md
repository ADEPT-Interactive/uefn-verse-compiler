# Headless Verse Research

Status: investigation branch, observed on Windows against an installed UEFN 42.10 build (CL 57819926) and Epic's `epicgames.verse` extension/language server 0.0.57819926. This document records interoperability evidence; it is not a claim that this repository contains or redistributes Epic tooling.

## Decision summary

- Gate A passed for the semantic path: the installed Epic Verse language server produced useful source diagnostics with both UEFN and VS Code absent from the process snapshot. The repository now has a reproducible `accept:lsp` harness for that contract.
- `check` is semantic analysis, not an authoritative UEFN build. Its default `push` mode retains generated-file diagnostics as auxiliary evidence and reports generated metadata as `unverified`; it does not turn those diagnostics into a source failure. An explicit `workspace`/`both` audit can classify metadata as `invalid`.
- The observed LSP still reports 174 generated-metadata errors for the converged `UTM_Demo` workspace. Controlled topology, transport, executable-copy, and generated-package experiments did not remove the built-in digest failures. This is unresolved compatibility evidence, not a reason to hide the diagnostics.
- `compile` remains the UEFN Workflow Server operation. Only its final numeric `numErrors` result is authoritative. No standalone or headless authoritative Verse compiler was proven.
- No current Workflow parity result is accepted from the disposable `Test` launch. The owner clarified that UEFN was only at the project switcher, and the process/log evidence did not prove a project was loaded. The parity runner now refuses to mutate a source file unless an active project and matching Workflow session are independently observed.

## Scope and safety

The investigation inspected locally installed executable metadata, extension configuration, generated project metadata, process/listener ownership, logs, and standard JSON-RPC behavior. It did not patch Epic files, redistribute binaries or VSIX content, publish an island, change account settings, or commit a user project. Gate A source probes used in-memory full-text replacements; the real `UTM_Demo` source remained unchanged. The disposable `Test` source was temporarily mutated by the guarded parity runner, restored byte-for-byte, and independently verified with SHA-256; its Workflow observations were discarded because the project-open precondition was not proven.

Machine-specific paths are represented with placeholders:

- `<UEFN_ROOT>` is the local Fortnite/UEFN installation root.
- `<USER_PROFILE>` is the Windows user profile.
- `<LOCALAPPDATA>` is the Windows local application-data directory.
- `<PROJECT_ROOT>` is the selected UEFN project directory.

## Confirmed

### Installed components

| Component | Observed evidence |
| --- | --- |
| UEFN executable | `<UEFN_ROOT>\FortniteGame\Binaries\Win64\UnrealEditorFortnite-Win64-Shipping.exe` |
| UEFN version | Version file reported `6.0.0`, changelist `57819926`, build id `57819925`; the executable version string identified `Fortnite+Release-42.10`. |
| Engine packaging | Verse functionality is registered in the shipping `.modules` manifest and packaged into monolithic `UnrealEditorFortnite-Common-Win64-Shipping.dll` and `UnrealEditorFortnite-Engine-Win64-Shipping.dll`. |
| Registered Verse modules | `VerseCompiler`, `VerseWorkflowServer`, `uLangCore`, `uLangDAP`, `uLangDigests`, `uLangJSON`, `uLangLSP`, `uLangUE`, and related Verse/editor modules were present. |
| Epic Verse extension | `epicgames.verse` extension version `0.0.57819926`; it contains `bin\Win64\verse-lsp.exe`. |
| Installed language server | `<USER_PROFILE>\.vscode\extensions\epicgames.verse-0.0.57819926\bin\Win64\verse-lsp.exe`; the executable identifies as `uLangServer` and carries the same release build string. |
| Generated project state | `<LOCALAPPDATA>\UnrealEditorFortnite\Saved\VerseProject\<project>\vproject\<project>.vproject`, project asset digest output, and built-in Verse, UnrealEngine, and Fortnite digest directories were present. |
| Project workspace | The generated `.code-workspace` contains source Content, project asset digests, read-only `vproject`, and Built-in Digests folders. |
| Commandlet executable | No expected `Engine\Binaries\Win64\UnrealEditor-Cmd.exe` or `UnrealEditorFortnite-Cmd.exe` was present. |
| Separate compiler binary | No standalone top-level Verse compiler binary was found; compiler functionality is inside the shipped engine package. |

The extension copies its bundled language-server executable to a temporary per-process path before spawning it when the default path is used. Its default argument list is empty, its server options do not set an explicit working directory, and its environment is inherited except for optional `VERSE_TRACE`. The client mirrors the relevant startup behavior while using the first generated workspace folder as the root/cwd.

### Gate A: standalone semantic acceptance

The acceptance run was performed with the named UEFN and VS Code processes absent before and after the corpus. Each case observed its own temporary `verse-lsp` process while it was alive, then completed JSON-RPC shutdown and left no tracked LSP process. The source SHA-256 map was unchanged before and after every in-memory probe.

The harness command is:

    npm run accept:lsp -- --project "<PROJECT_ROOT>\\UTM_Demo.uefnproject" --mode gate-a

The gate contract passed with the default `push` transport:

- clean source: zero source errors;
- syntax, unknown identifier, type mismatch, effect, invalid import, invalid override, invalid access, and wrong-argument probes: each produced the expected source diagnostic or category;
- generated metadata was retained separately from source diagnostics;
- temporary LSP process was observed alive at spawn and absent after shutdown;
- UEFN and VS Code remained absent; source hashes remained unchanged.

The source probes are in-memory. The harness does not write project source, so it is safe to run while the project is closed.

### Epic extension and LSP fidelity

Read-only inspection of the installed extension and its bundled `vscode-languageclient` showed:

- first workspace folder path/URI is used for `rootPath`/`rootUri` and as the client working directory;
- the exact generated workspace folder names and paths are sent, rather than a basename-only synthetic topology;
- official-shaped workspace, synchronization, diagnostics, dynamic-registration, completion, hover, and work-done capabilities are advertised;
- `initializationOptions` is absent/undefined, trace is off by default, and no custom initial workspace-folder notification is sent;
- the client replies to `client/registerCapability`, watched-file registrations, and `workspace/configuration` requests;
- the actual extension contains no manual `workspace/diagnostic` or `textDocument/diagnostic` request path;
- Epic's server advertised no `textDocument/diagnostic` pull capability in the observed run.

The independent client therefore defaults to push publications. `workspace` and `both` are explicit investigation modes, not the normal extension contract. `pull` is exposed only to characterize unsupported behavior and returns a structured unsupported error with clean protocol shutdown.

### Generated metadata and the 174-diagnostic result

For `UTM_Demo`, the generated workspace topology was:

1. source Content, named `/adeptinteractive@fortnite.com/UTM_Demo (UTM_Demo)`;
2. project asset digests, named `/adeptinteractive@fortnite.com/UTM_Demo (UTM_Demo/Assets)`;
3. read-only generated `vproject`, named `vproject (read-only)`;
4. Built-in Digests.

The generated package graph contained `UTM_Demo`, `UTM_Demo/Assets`, `Verse`, `UnrealEngine`, and `Fortnite`; the header digest files identified CL 57819926. With the exact topology and a settled push run, the server returned 174 metadata errors with these observed code totals:

| Generated area | Main observed codes/counts |
| --- | --- |
| `Verse` | `3502:92`, `3503:1`, `3506:1`, `3509:57`, `3523:5`, `3591:17` |
| `UnrealEngine` | `3502:4` |
| `Fortnite` | `3591:16` |
| project `.vproject` | `3677:1` |

The breakdown is retained by package, file, code, severity, and normalized message pattern by the acceptance harness. Controlled experiments were also run in a safe generated-root clone:

- removing the `UnrealEngine -> Fortnite` dependency cycle changed 174 errors to 172 and replaced the cycle-dependent `3502` results with three `3507` results;
- disabling `enableVNI` did not change the total;
- using the exact official folder names, content-only folders, root/basename variants, null configuration, no `didChange`, direct executable, and temporary-copy executable did not produce a clean valid topology result;
- omitting `vproject` hid the generated diagnostics, but also removed the package context required for a valid project check, so it is not an accepted fix.

The evidence points to a genuine built-in digest/package compatibility or generated-metadata validity issue in this installed build. It does not point to a client-only workspace-folder or configuration mistake. A fresh UEFN regeneration experiment remains an owner-controlled follow-up.

### Diagnostic semantics and timings

`check` now distinguishes source diagnostics from generated metadata diagnostics and exposes `metadataHealth`:

- default `push`: `metadataHealth: unverified`; source status is usable even when auxiliary generated diagnostics are present;
- explicit `workspace` or `both`: `metadataHealth: invalid` when the workspace report contains metadata errors, and status is `metadata-invalid` unless source errors are present;
- `pull`: experimental; the observed server did not advertise the required capability and the client reports that fact without treating clean shutdown as a semantic failure.

Timings are structured as `spawnMs`, `startupMs`, `initializeMs`, `firstDiagnosticMs`, `workspaceDiagnosticMs`, `analysisSettledMs`, `shutdownMs`, and `totalMs`. Representative fresh-process UTM runs were approximately 1.9–2.3 seconds total with a 500–1200 ms settle window; initialization was about 15–20 ms, first diagnostics about 0.9–1.1 seconds, and an explicit workspace report about 350–380 ms after its request. These are wall-clock interoperability timings, not throughput benchmarks.

### Persistent-process measurement

The repository also includes a measurement-only persistent probe:

    npm run measure:lsp -- --project "<PROJECT_ROOT>\\UTM_Demo.uefnproject" --settle-ms 1200 --timeout-ms 5000 --json

Against the real `UTM_Demo` source, one long-lived temporary-copy LSP process initialized in 555 ms after spawn and shut down cleanly. The first publication arrived at 463 ms; after a 1200 ms settle window, the selected source still had zero source diagnostics and no source-specific publication. A same-file edit containing `DefinitelyMissing` did not produce the expected `3506` publication within 5 seconds, and the subsequent same-file clean edit also produced no expected publication within 5 seconds. The source SHA-256 was unchanged. `UTM_Demo` exposes only one Verse source file, so cross-file behavior was unavailable in this run.

This is evidence that the installed server's incremental/watch behavior is not proven through the observed push protocol. The implementation therefore keeps the one-shot semantic check as the supported path and does not ship a persistent or watch mode based on this measurement.

### Source diagnostic corpus

The installed LSP reproduced the following source-level categories from in-memory text replacements over the real source path:

| Case | Observed result |
| --- | --- |
| Valid source | No source errors. |
| Syntax | Verse syntax/operator diagnostic, code `3100`. |
| Unknown symbol | `Unknown identifier DefinitelyMissing`, code `3506`. |
| Type mismatch | Incompatible initializer for an `int`, code `3509`. |
| Effect violation | `Sleep` in a non-suspending context, code `3512`. |
| Bad import/module | Invalid logical scope, code `3587`. |

### Workflow and project identity

The Workflow client remains unchanged in authority: it sends `compileProject` over a UEFN-owned loopback TCP listener and requires a final `type: 2`, `command: compileProject` response with numeric `numErrors`. A listener or a zero result without project identity is not enough.

The disposable `Test` experiment showed why that distinction matters. Launching the shipping executable with `-unattended -nullrhi -nosplash -nosound -nop4` produced a normal responsive editor window and Workflow listeners. A quoted `-project` argument later produced the normal `Unreal Editor for Fortnite` window, but the owner clarified that the UI was only the project switcher; the local toolchain report had `activeProjectDetected: false`, and the log contained `no main project`. The resulting `compileProject` zero response and all parity Workflow rows are therefore discarded as non-project-scoped evidence.

The committed parity runner now requires a matching active-project record and Workflow session before it writes any source variant. It then snapshots bytes and SHA-256, writes deterministic invalid variants, runs LSP and Workflow, records source codes/categories/timings/metadata behavior, restores the exact bytes in each case's `finally`, restores again in the outer `finally`, and aborts with a distinct failure if verification fails.

Run it only after the owner has opened the named disposable project in UEFN:

    npm run parity:verse -- --project "<PROJECT_ROOT>\\Test.uefnproject" --process-id <PID> --confirm-disposable --json

If the project is at the switcher, closed, mismatched, or not independently identified, the tool performs no mutation and exits unavailable. The current branch has not accepted a project-open parity matrix.

## Headless and commandlet investigation

### Shipping executable probe

With UEFN and VS Code absent, the installed shipping executable was launched once with:

    -help -unattended -nullrhi -nosplash -nosound -nop4

After more than five seconds it was still a normal responsive window titled `Unreal Editor - FortniteGame`, owned the historical `127.0.0.1:1962` listener, and used several gigabytes of working set. The exact disposable process was closed and verified absent. `-unattended`, `-nullrhi`, `-nosplash`, and `-nullrhi` did not establish a headless service.

### VerseBuilder probe

Against the disposable `Test` descriptor, the requested candidate was launched once with:

    -run=VerseBuilder -unattended -nullrhi -nosplash -nosound -nop4 -project="<PROJECT_ROOT>\\Test.uefnproject"

The log recorded:

    VerseBuilderCommandlet looked like a commandlet, but we could not find the class.
    Engine exit requested (reason: Failed to find commandlet class VerseBuilderCommandlet)

No Workflow listener was exposed by that run. It still created a normal editor window during startup and was closed/verified by exact PID. This is evidence against a runnable `VerseBuilder` commandlet in this shipping installation, not a compile result.

### Unsupported conclusions

- No standalone or headless authoritative compiler was demonstrated.
- No dedicated commandlet executable was present at the expected locations.
- Generic commandlet infrastructure, module names, or an editor build-errors UI string do not prove a runnable Verse commandlet.
- The monolithic presence of `VerseCompiler` does not expose a supported generic command-line ABI.
- The LSP cannot become the default authoritative `compile` backend without comparative build, artifact, and project-state evidence.

## Diagnostic parity matrix

| Case | Epic Verse LSP | UEFN Workflow | Headless authoritative backend |
| --- | --- | --- | --- |
| Valid source | Detected; zero source errors; generated metadata retained separately. | No accepted project-open run in this continuation. | None available. |
| Syntax error | Detected, source code `3100`. | Not accepted; the previous disposable launch was at the project switcher. | Not proven. |
| Unknown identifier | Detected, source code `3506`. | Not accepted. | Not proven. |
| Type mismatch | Detected, source code `3509`. | Not accepted. | Not proven. |
| Effect error | Detected, source code `3512`. | Not accepted. | Not proven. |
| Module/import error | Detected, source code `3587`. | Not accepted. | Not proven. |
| Asset-reflection dependency | Not yet tested. | Not yet tested. | Not proven. |

The table intentionally does not equate “detected” with “equivalent.” A future run must begin with owner-confirmed project identity, compare the same on-disk source and generated state through both paths, and record artifacts and restoration hashes.

## Decision gates

| Gate | State | Reason |
| --- | --- | --- |
| A: standalone semantic analysis | Passed | The installed Epic LSP reproduced the source corpus with UEFN and VS Code absent; the acceptance harness proves process cleanup and source immutability. Generated metadata remains separately reported/unverified by default. |
| B: headless compilation | Not passed | The shipping executable launched a normal editor process; no runnable VerseBuilder commandlet or separate headless compiler was found. |
| C: authoritative headless compilation | Not passed | No candidate backend has comparative build/artifact evidence. |

Until Gate C passes, no headless candidate may become the default for `compile`. Any future candidate must be labeled `experimental / authoritative equivalence unverified`.

## Implementation in this branch

- Added read-only discovery of `.uefnproject`, generated `.vproject`, exact generated workspace folders, source files, and digest packages.
- Reworked the LSP client around the observed Epic startup contract, temporary executable copy, stdio framing, dynamic requests, official folder names, explicit diagnostic modes, structured protocol observations, clean shutdown, and timing fields.
- Added source/metadata diagnostic separation, `metadataHealth`, and explicit `workspace`/`pull` experiment semantics without changing Workflow authority.
- Added `accept:lsp` for process-state, source-hash, diagnostic-corpus, metadata-breakdown, protocol, and timing evidence.
- Added `measure:lsp` as a non-mutating persistent-process probe for incremental same-file and cross-file capability evidence; the current installed server did not pass the same-file warm-edit observation.
- Added guarded `parity:verse`, which requires explicit disposable acknowledgement and an independently identified active Workflow project before any on-disk mutation.
- Kept `compile`, its loopback restrictions, fail-closed session selection, retry behavior, JSON shape, and final numeric `numErrors` authority intact.

## Reproduction commands

From a built checkout:

    npm run verse-compile -- doctor --project "<PROJECT_ROOT>\\Project.uefnproject" --json
    npm run verse-compile -- backends --json
    npm run verse-compile -- check --project "<PROJECT_ROOT>\\Project.uefnproject" --json
    npm run verse-compile -- check --project "<PROJECT_ROOT>\\Project.uefnproject" --diagnostic-mode workspace --json
    npm run verse-compile -- compile --project "<PROJECT_ROOT>\\Project.uefnproject" --json
    npm run accept:lsp -- --project "<PROJECT_ROOT>\\Project.uefnproject" --mode gate-a
    npm run measure:lsp -- --project "<PROJECT_ROOT>\\Project.uefnproject" --settle-ms 1200 --timeout-ms 5000 --json

The JSON output from `doctor` and `backends` omits executable and project paths unless `--include-paths` is supplied. Semantic JSON always separates source and metadata diagnostics; it must not be consumed as a `compile` result.

## Open questions and next work

1. Run the guarded parity matrix only after owner-confirmed `Test` project identity is available; compare Workflow diagnostics against the same on-disk variants.
2. Determine whether a fresh UEFN regeneration produces a digest set accepted by the installed LSP, without changing production project files.
3. The persistent same-file measurement did not produce warm invalid or clean publications within the deadline; investigate only against a future server/build or a genuinely multi-file disposable project before considering watch-mode work.
4. Revisit direct `VerseCompiler` hosting only if a supported smaller host boundary is exposed by future Workflow/commandlet evidence.
