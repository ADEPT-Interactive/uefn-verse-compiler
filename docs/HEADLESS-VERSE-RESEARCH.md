# Headless Verse Research

Status: investigation branch, observed against a locally installed UEFN 42.10 build (CL 57819926) on Windows. This document records interoperability evidence; it is not a claim that this repository contains or redistributes Epic tooling.

## Decision summary

- `check` is a semantic-analysis operation backed by Epic's installed Verse language server. It can obtain source diagnostics without VS Code and does not claim an authoritative build.
- `compile` remains the existing UEFN Workflow Server operation. Its final numeric `numErrors` result remains the only authoritative compile signal in this package.
- No standalone or headless authoritative Verse compiler was proven. No experimental headless compile backend is exposed.
- The language-server path is useful, but Gate A is not yet passed: the strongest real probe kept UEFN open, and the converged workspace report exposed generated-digest diagnostics that must be resolved before declaring a clean standalone project check.

## Scope and safety

The investigation inspected locally installed executable metadata, extension configuration, generated project metadata, process/listener ownership, logs, and standard JSON-RPC behavior. It did not patch Epic files, redistribute binaries or VSIX content, expose a listener beyond loopback, publish an island, change account settings, or commit a user project. Real invalid-source probes used in-memory full-text overrides; the on-disk Verse source was not changed.

Machine-specific paths are represented with placeholders:

- `<UEFN_ROOT>` is the local Fortnite/UEFN installation root.
- `<USER_PROFILE>` is the Windows user profile.
- `<LOCALAPPDATA>` is the Windows local application-data directory.
- `<PROJECT_ROOT>` is the selected UEFN project directory.

## Confirmed

### Installed components

The observed installation contained:

| Component | Observed evidence |
| --- | --- |
| UEFN executable | `<UEFN_ROOT>\FortniteGame\Binaries\Win64\UnrealEditorFortnite-Win64-Shipping.exe` |
| UEFN version | Version file reported `6.0.0`, build/changelist `57819926`, build id `57819925`; the executable version string identified `Fortnite+Release-42.10`. |
| Engine packaging | The relevant Verse modules are registered in the shipping `.modules` manifest and are packaged into monolithic `UnrealEditorFortnite-Common-Win64-Shipping.dll` and `UnrealEditorFortnite-Engine-Win64-Shipping.dll`. |
| Registered Verse modules | `VerseCompiler`, `VerseWorkflowServer`, `uLangCore`, `uLangDAP`, `uLangDigests`, `uLangJSON`, `uLangLSP`, `uLangUE`, and other Verse/asset/editor modules were present in the manifest. |
| Epic Verse extension | `epicgames.verse` extension version `0.0.57819926`; the package contains a Windows `bin\Win64\verse-lsp.exe`. |
| Installed language server | `<USER_PROFILE>\.vscode\extensions\epicgames.verse-0.0.57819926\bin\Win64\verse-lsp.exe`; the executable identifies itself as `uLangServer` and has the same release build string. |
| Generated project state | `<LOCALAPPDATA>\UnrealEditorFortnite\Saved\VerseProject\<project>\vproject\<project>.vproject`, project asset digest output, and built-in Verse, UnrealEngine, and Fortnite digest directories were present. |
| Project workspace | The generated `.code-workspace` contains source Content, project asset digests, the read-only `vproject` directory, and the Built-in Digests directory. |
| Asset reflection | The observed project had a generated project-specific `UTM_Demo-Assets.digest.verse` package. The repository does not contain that file. |
| Commandlet executables | No `Engine\Binaries\Win64\UnrealEditor-Cmd.exe` or Fortnite-specific `UnrealEditorFortnite-Cmd.exe` was present at the expected locations in this installation. |
| Separate compiler binary | No standalone `VerseCompiler.dll` or `Verse.dll` was found at the expected top-level binary locations; the module manifest maps compiler functionality into the monolithic engine binary. |

The extension configuration uses an optional `verse.serverPath` and `verse.serverArguments`. With the default path, the Windows extension copies the bundled language-server executable to a temporary per-process path before starting it. The default argument list is empty. The optional trace setting adds `VERSE_TRACE`; no other required environment variable was found in the observed startup path. The extension's server options do not set an explicit working directory; this client uses the project Content directory as the child-process working directory.

### Language-server startup contract

The independently implemented client uses the following observed contract:

1. Spawn `verse-lsp.exe` with stdio pipes. VS Code is not launched.
2. Send standard LSP `initialize` with a null root URI for the multi-root project and workspace folders derived from the generated code-workspace. Advertised client capabilities cover workspace folders, configuration, dynamic watched-file registration, document synchronization, diagnostics, and work-done progress.
3. Reply to server requests such as `client/registerCapability`, `client/unregisterCapability`, and `workspace/configuration`. The observed registration set included workspace symbols, `.vproject`/`.vpackage` file watching, and Epic's `uLangServer/workspace/didChangeWorkspaceFolders` capability. Replying to registration was sufficient; no proprietary custom request had to be sent before diagnostics appeared. No proprietary source code is copied into this repository.
4. Send `initialized`.
5. Send `textDocument/didOpen` followed by a full-text `textDocument/didChange` for each source file. The second notification is important for deterministic source analysis in the standalone probe.
6. Request standard `workspace/diagnostic` with an empty previous-result list. The observed server returns a report containing full diagnostic items for generated packages and the project `.vproject`; source diagnostics are also published through `textDocument/publishDiagnostics`.
7. Normalize LSP zero-based ranges and severities into the package's one-based diagnostic shape.
8. Shut down with a JSON-RPC `shutdown` request, send `exit`, and close stdio. The observed executable may report a non-zero process exit value during this sequence; the protocol result, not that process value, is the semantic signal.

Messages use ordinary `Content-Length: <UTF-8 byte length>` framing followed by JSON-RPC JSON. Epic percent-encodes the Windows drive colon in some file URIs (`file:///C%3A/...`); the client accepts both that form and the conventional `file:///C:/...` form.

### Project association and metadata

The generated `.vproject` describes the source Content package, project asset package, built-in packages, roles, and read-only state. The client discovers it read-only from the project descriptor and the local generated `VerseProject` tree. Digest files are catalogued but never copied into the repository or rewritten. A timestamp-only `metadataFreshness` field is deliberately described as a heuristic: it can say `possibly-stale` when source content is newer than the `.vproject`, but it cannot establish that UEFN's internal state is current.

### Direct semantic observations

With UEFN still open and VS Code confirmed closed, direct stdio probes against the installed language server produced these source diagnostics from in-memory text replacements over the real source path:

| Case | Result from Epic LSP |
| --- | --- |
| Valid source | No source diagnostic in the initial clean probe. |
| Syntax error | `vErr:S77: Unexpected "!" following expression`, code `3100`, useful source range. |
| Unknown symbol | `Unknown identifier \`DefinitelyMissing\``, code `3506`. |
| Type mismatch | Incompatible `[]char` initializer for an `int` variable, code `3509`. |
| Effect violation | Calling `Sleep` from a non-suspending context is not allowed, code `3512`. |
| Bad import/module | Invalid logical-scope identifier in `/Definitely/No/Such/Module`, code `3587`. |

The source file remained unchanged after every case. On the converged generated workspace, each invalid source run also produced 174 diagnostics in built-in digest and `.vproject` files. These are retained separately as `metadataDiagnostics`; they are not relabeled as source errors. A repeated valid run can also surface those generated-package diagnostics, so the implementation returns `metadata-invalid` rather than claiming a clean project check when metadata itself is reporting errors.

This proves that the installed LSP can perform useful standalone semantic analysis with VS Code closed. It does not yet prove the required both-closed acceptance condition because the owner-controlled UEFN process was deliberately left running.

### Existing Workflow baseline

The unchanged `compile` path was run against the same known-clean project while UEFN was open. The process-owned loopback Workflow Server returned:

- `type: 2`, `command: compileProject`;
- numeric `numErrors: 0` and `numWarnings: 0`;
- a successful authoritative compile result;
- a process-owned loopback session, not an LSP session.

The existing client still treats this final numeric `numErrors` as the authority. A connected socket, an LSP result, or a language-server process exit is not substituted for it.

### Workflow Server host observation

The observed UEFN shipping process owned the Workflow Server loopback listeners, including the historical port 1962. Process-tree inspection showed no separate compiler or Workflow child process, and the relevant module names are inside the monolithic shipping engine DLL. This makes `requiresUefnProcess: yes` evidence-backed for the current Workflow backend. Whether the service requires a visible Slate/GUI surface after the UEFN process is initialized remains `unknown`; the inventory does not justify claiming GUI independence.

## Probable

- The current Workflow Server is embedded in the main UEFN process and initialized as part of editor/project startup rather than as a separately launchable service.
- The language server is editor-independent at the process boundary, but its semantic universe depends on generated `.vproject` topology and digest files. A missing or semantically incompatible metadata set prevents a trustworthy project-level result.
- Directly hosting `VerseCompiler` would likely require an Epic-compatible Unreal/Fortnite host and the same generated package state. The manifest proves that the module ships; it does not expose a supported generic command-line ABI.

## Unsupported / disproven

- No headless authoritative compiler was demonstrated.
- No dedicated `UnrealEditor-Cmd.exe` was available in the observed installation, so the commonly mentioned `UnrealEditor-Cmd.exe -run=VerseBuilder` path cannot be treated as an available local command.
- A targeted string inspection found no exact `VerseBuilder` commandlet registration or `VerseCompilerCommandlet` host in the inspected shipping binary metadata. Generic commandlet infrastructure and an editor build-errors UI string are not evidence of a runnable Verse commandlet.
- The language server's diagnostics cannot be called an authoritative build: it does not return the Workflow `compileProject` authority, does not produce the same proven artifacts, and currently reports generated-package diagnostics that can be independent of source diagnostics.
- A first short check that completed before metadata diagnostics converged was not accepted as proof of a clean project. The client now waits for the workspace report and exposes metadata errors instead of hiding them.

## Diagnostic parity matrix

This is the evidence available in this investigation. “Not run” is intentional: the Workflow path reads the on-disk source, and deliberately breaking the open generated project would cross a safer owner-controlled acceptance boundary.

| Case | Epic Verse LSP | UEFN Workflow | Headless authoritative backend |
| --- | --- | --- | --- |
| Valid source | Source diagnostics: none in the initial probe; converged workspace may report generated metadata errors. | Clean baseline, `numErrors: 0`. | None available. |
| Syntax error | Detected, source code `3100`; generated metadata diagnostics also observed. | Not run against the real project. | Not proven. |
| Unknown identifier/type | Detected, source code `3506`. | Not run against the real project. | Not proven. |
| Type mismatch | Detected, source code `3509`. | Not run against the real project. | Not proven. |
| Effect error | Detected, source code `3512`. | Not run against the real project. | Not proven. |
| Module/import error | Detected, source code `3587`. | Not run against the real project. | Not proven. |
| Asset-reflection dependency | Not yet tested. | Not yet tested. | Not proven. |

The matrix intentionally does not equate “detected” with “equivalent.” A future parity fixture must compare the same on-disk source and generated state through both paths, including artifacts and state where relevant.

## Commandlet and direct-module investigation

The installed build was searched for the expected command-line executables and relevant module registrations. The result was:

- `VerseCompiler` and `VerseWorkflowServer` are registered modules in the shipped monolithic engine package.
- No expected commandlet executable was found.
- No exact runnable `VerseBuilder` registration was established.
- No commandlet was launched against the open user project. A valid/failure commandlet comparison therefore remains an open experiment, not a failed compile result.

The next safe commandlet experiment requires the owner to close UEFN and a disposable project whose generated metadata can be restored. It must record exit code, diagnostics, artifacts, process tree, and whether a normal editor process appears before any backend is described as headless.

## Timing methodology

Timings below are wall-clock measurements from fresh child processes on the observed Windows machine. They include language-server startup, initialization, workspace association, source notifications, workspace diagnostics, and protocol shutdown; they are not compiler-throughput benchmarks.

| Operation | Observed timing |
| --- | --- |
| LSP cold source check | Approximately 1.6–1.9 seconds per fresh process in the six-case probe; first diagnostic publication was approximately 0.15–0.43 seconds. |
| Workflow clean baseline | Approximately 3.4 seconds for the CLI invocation including Node startup and the live Workflow round trip. |
| Warm LSP edit | Not measured; the implementation currently uses one process per `check`. |
| Persistent/watch mode | Not implemented. |

No sub-second warm-mode claim is made. A future persistent local service should measure spawn, initialization, first diagnostic, same-file edit, and cross-file edit separately.

## Implementation in this branch

- Added read-only project metadata discovery for `.uefnproject`, generated `.vproject`, workspace folders, source files, and digest packages.
- Added read-only local toolchain discovery for UEFN, the installed Epic extension/LSP, shipped module registrations, process state, and expected commandlet paths.
- Added explicit backend capability descriptors. The LSP says semantic analysis yes and authoritative compilation no; the Workflow backend says authoritative compilation yes and requires a UEFN process; GUI coupling remains unknown.
- Added `check`, `doctor`, and `backends` CLI commands. `check` has distinct semantic statuses, source/metadata diagnostic counts, timing, and `authoritative: false` / `semantic: true` markers.
- Kept `compile`, its Workflow protocol, loopback restrictions, fail-closed session selection, retry behavior, JSON shape, and authority rule intact.
- Added synthetic CI fixtures for framing-independent LSP JSON-RPC lifecycle, dynamic requests, URI/range normalization, metadata discovery, timeout handling, and capability reporting.

## Decision gates

| Gate | State | Reason |
| --- | --- | --- |
| A: standalone semantic analysis | Pending | Useful source diagnostics were reproduced with VS Code closed, but UEFN was not owner-confirmed closed and generated metadata diagnostics need resolution. |
| B: headless compilation | Not passed | No commandlet or other real compilation path was demonstrated without the normal UEFN process. |
| C: authoritative headless compilation | Not passed | No candidate backend exists with comparative build/artifact evidence. |

Until Gate C passes, any future candidate must be labeled `experimental / authoritative equivalence unverified` and must not become the default for `compile`.

## Reproduction commands

From a built checkout:

    npm run verse-compile -- doctor --project "<PROJECT_ROOT>\Project.uefnproject" --json
    npm run verse-compile -- backends --json
    npm run verse-compile -- check --project "<PROJECT_ROOT>\Project.uefnproject" --json
    npm run verse-compile -- compile --project "<PROJECT_ROOT>\Project.uefnproject" --json

The JSON output from `doctor` and `backends` omits executable and project paths unless `--include-paths` is supplied. `check` always identifies the selected project and diagnostic files because those locations are part of its result.

## Open questions and next work

1. Owner-controlled Gate A: close UEFN, independently prove the process is absent, rerun the valid and invalid corpus, and capture the exact state without modifying a production island.
2. Determine why the current generated built-in digest set yields 174 LSP metadata diagnostics in the converged multi-root workspace and whether a fresh UEFN-generated metadata set removes them.
3. Run Workflow parity for the same deterministic cases using a disposable on-disk fixture and automatic restoration.
4. With UEFN closed, investigate any actually present commandlet or a safe help/listing path; do not infer `VerseBuilder` from third-party mentions.
5. Measure a persistent LSP process and decide whether a future `watch`/`serve` mode is worth the lifecycle and stale-state complexity.
6. Revisit direct `VerseCompiler` hosting only if the commandlet and Workflow-host experiments expose a supported, smaller boundary.
