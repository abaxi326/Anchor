# Open Anchor

A personal VS Code coding agent powered by the **Pi SDK** and an inference worker on your manually managed GPU. Enter its API address, click **Connect**, and give the agent a coding task.

```text
VS Code sidebar <-> local Pi process <-> your files, terminal, and tests
                            |
                        HTTP / HTTPS
                            |
               Vast inference worker (vLLM + Qwen)
```

Open Anchor does not use the Vast.ai API. You rent, start, stop, and destroy instances yourself. **Disconnect stops the local agent; your GPU stays running.** Pi runs beside your project; the GPU worker serves inference.

## Install

1. Install Node.js **22.19 or newer** on the machine that hosts your VS Code workspace. Restart VS Code after installing Node so it receives the updated PATH. You can also set `openAnchor.nodePath` to the executable's absolute path.
2. Install `rg` (ripgrep) and `fd` on that machine's PATH for Pi's repository search tools. Open Anchor disables Pi's automatic downloads. Native Windows commands use PowerShell; Linux/WSL commands use Bash.
3. In VS Code, run **Extensions: Install from VSIX…** and choose `open-anchor-0.1.0.vsix`.
4. Open and trust your project folder, then select the Open Anchor icon in the Activity Bar.

For WSL, a dev container, or Remote SSH, install the extension in that environment. Node, search tools, and command dependencies must be available there. Each window uses one selected workspace; a multi-folder window prompts you to choose.

## Start the model manually

Deploy the supplied `worker/Dockerfile` as a Vast Entrypoint template, or use the equivalent official vLLM image configuration in `docs/gpu-setup.md`. The worker downloads/loads the model, serves streaming completions and tool calls, and exposes health/model endpoints on port 8000. It reuses vLLM's API server directly. A starting configuration is one **RTX 5090 32 GB**, Qwen3.8-27B NVFP4, and a 32K context, following the upstream recipe linked in the guide.

The template deploys the worker when you start the instance. Its model must finish loading before Connect succeeds. An inference URL cannot install software on a bare machine: deployment happens through the Vast template, without an SSH connection from the extension.

## Connect

The default direct API connection needs just the worker's address:

| Field | Example / meaning |
|---|---|
| API address | `http://203.0.113.10:31234`, bare `203.0.113.10:31234`, or your worker's HTTPS proxy URL; `/v1` is added if omitted |
| API key | Optional; the worker's `VLLM_API_KEY`, if configured. This is not your Vast account API key |
| Model ID | `open-anchor` with the supplied startup script; empty auto-detects only when exactly one model is advertised |
| Context window | `32768`; must agree with the server configuration |
| Output token limit | `8192`; must be smaller than the context window |
| Model reasoning | Enabled for Qwen thinking models; disable for a non-thinking model |

Model limits and optional SSH settings are under advanced options. Credentials are saved through VS Code SecretStorage, never in workspace settings or command arguments. Empty inputs retain previously saved values. Use **Open Anchor: Forget Connection Secrets** from the Command Palette to remove saved credentials for the selected profile.

Use the external port mapped to internal port **8000**, not the port from Vast's SSH command. A proxy must expose the worker's HTTP API without a browser login; an SSH proxy cannot carry HTTP requests directly. Query-token login URLs are not supported. An optional API key uses bearer authentication.

Connect checks `/v1/models`, automatically selects a sole advertised model, and starts Pi. Your first coding task then exercises streaming tool calls. Redirects are rejected; enter the final API URL.

Optional **SSH tunnel** mode accepts host, SSH port, username, private-key file, and remote model port. It verifies and remembers host fingerprints, forwarding a local port to the model server. It requires an SSH-capable instance and is unnecessary for a directly reachable worker.

## Code with Pi

- **Plan** exposes read-only file and search tools. Start here to inspect a project.
- **Agent** also enables Pi's edit, write, and shell tools. Each edit or command asks for approval.
- Enter sends a task; Shift+Enter adds a line. **Stop** cancels generation and pending approvals.
- Tool cards show inputs, output, and failures. The model can use failures to correct its next action.
- **Review** opens a native VS Code diff for edits made through file tools. **Undo** restores the captured baseline only if the file has not changed afterward. Save unsaved editor buffers before approving edits.
- Shell commands can also change files; inspect those changes through VS Code's Source Control view. They are not covered by per-file undo snapshots.
- Sessions persist in the extension's local storage. Reconnect automatically restores the last session for the selected workspace; it waits for your next prompt rather than rerunning completed work. **New** starts a fresh conversation.

Session history persists across VS Code restarts. Per-file undo snapshots currently live in memory, so review them before reloading VS Code or creating a new session. Existing uncommitted work is preserved when capturing an edit baseline. If you manually edit a file between agent edits, that newer content becomes the next undo baseline.

## Execution and data boundaries

Pi runs beside your workspace, using its real coding tools, session manager, provider adapter, and context compaction. Root-level `AGENTS.md` is loaded as instruction text. Executable Pi project extensions, user packages, and skill discovery are disabled in this first version. File-tool paths are checked against the workspace and symlink/junction escapes are rejected.

Approved shell commands run with your account's permissions. This is **not an operating-system sandbox**; use a dev container or isolated workspace when that boundary is needed. Repository snippets and tool outputs are sent to your GPU model. HTTPS and SSH encrypt transport; plain HTTP does not. The GPU host processes that content. Local session files may contain source and tool output.

## Develop

```powershell
npm ci --ignore-scripts
npm run check
npm run test:ui
npm run package
```

Press **F5** to launch an Extension Development Host. Open a project there and select Open Anchor. `npm run watch` rebuilds while you work. Browser tests use installed Microsoft Edge on Windows, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; on other systems install a Playwright Chromium browser with `npx playwright install chromium`.

Tests use local SSH and mock OpenAI-compatible servers: they exercise the actual Pi worker, reasoning/tool-message continuity, approvals, file edits, shell execution, session resume, tunneling, and cancellation without requiring a GPU. Browser tests check the sidebar workflow and safe text rendering. A live Vast.ai/Qwen evaluation requires your running instance and is separate from these checks.

| Path | Responsibility |
|---|---|
| `src/extension.ts` | VS Code lifecycle, state, secrets, approvals, and diffs |
| `src/connection/` | Direct HTTP(S), optional SSH, and model discovery |
| `src/agent/` | Pi SDK runtime and guarded tool adapters |
| `src/runtime/` | Isolated Node process and JSONL transport |
| `src/review/` | Change snapshots and conflict-aware undo |
| `src/webview/` | Sidebar interface |
| `worker/` | Deployable inference container and Vast template settings |

## Troubleshooting

- **Cannot start Pi:** check `node --version` in the workspace environment and the `openAnchor.nodePath` setting.
- **SSH authentication failed:** verify the instance's SSH username/port, that the corresponding public key is installed, and your private-key passphrase.
- **Model readiness failed:** wait for vLLM to finish loading; verify the URL uses the mapped model port and the optional API key matches. Direct access requires vLLM to listen on `0.0.0.0`, as the supplied worker does.
- **Unknown model:** use the ID returned by `/v1/models`, which may differ from its Hugging Face repository when `--served-model-name` is used.
- **Tool calls appear as text:** check the GPU's vLLM tool parser and `--enable-auto-tool-choice` flags.
- **Search executable unavailable:** install `rg` and `fd`, restart VS Code, and reconnect.
- **Out of memory/context exceeded:** reduce server context/concurrency and keep the extension's context setting in sync. Model reasoning also consumes output tokens.
- **Connection dropped:** reconnect after fixing the network/server; completed tool actions remain in the transcript. Check the workspace before asking the model to continue an interrupted edit.

Pi is MIT-licensed. See `NOTICE` for attribution and [Pi SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) for the reused runtime.
