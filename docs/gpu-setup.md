# Start the model on Vast.ai

Open the **SSH terminal on your running Vast instance**, then run:

```bash
git clone https://github.com/abaxi326/Anchor.git
cd Anchor
bash scripts/vast-server.sh
```

For an existing checkout, run these from its `Anchor` directory:

```bash
git pull --ff-only
bash scripts/vast-server.sh
```

The script installs a private Python environment, downloads the model as needed, starts vLLM in the background, and waits for `/v1/models` to respond. No Node.js, npm, VSIX installation, or Docker build is needed on the GPU. Pi and the VS Code extension run beside your coding workspace; Vast runs inference.

## Default profile for the CMP 170HX allocation

The bootstrap uses **`Qwen/Qwen3.8-27B` in BF16**, a **16,384-token context**, and one concurrent request. It serves the model as **`open-anchor`** on **`127.0.0.1:8000`**. This is the starting profile for your approximately 68 GB GPU allocation; the script checks the actual GPU capability and memory. Its default minimum is **60 GiB total GPU memory**. That is a capacity guard, not a benchmark or a guarantee that every CMP 170HX configuration can run this model. Keep the GPU free of other workloads so that memory is available to BF16 inference.

Run this on **Linux x86_64**, with **Python 3.10–3.14 and venv support**, an NVIDIA GPU exposed to the instance, and a compatible driver. The installer uses the **vLLM 0.28.0 CUDA 12.9 wheel** in its own environment. Preflight requires Linux driver **575.57.08 or newer** and checks total GPU memory; after installing dependencies, the bootstrap also checks CUDA/BF16 capability. It does not install host drivers, run apt, or change global Python packages. Use a Vast image with these prerequisites already available. See [vLLM installation requirements](https://docs.vllm.ai/en/v0.28.0/getting_started/installation/gpu/) and [NVIDIA's CUDA 12.9 driver table](https://docs.nvidia.com/cuda/archive/12.9.2/cuda-toolkit-release-notes/index.html).

Allow disk space for the Python environment and model cache. First startup includes large downloads and initialization. The bootstrap enables Qwen reasoning and tool parsers; the [upstream model recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B) documents those serving options. This project has not yet validated the BF16 profile on your live CMP 170HX instance.

## Connect from VS Code

The default server listens on the instance's loopback interface. In Open Anchor, open **Advanced connection & model options**, select **SSH tunnel**, and use:

| Field | Value |
| --- | --- |
| SSH host, port, username | The values from Vast's SSH command |
| Private key file | Your local private key matching the public key configured in Vast |
| Model server port | `8000` |
| Model ID | `open-anchor`, or leave empty to auto-detect the sole model |
| Context window | `16384` |
| Output token limit | `4096` |
| Model reasoning | Enabled |
| Model API key | Only if you set `VLLM_API_KEY` on the server |

Click **Connect** after the bootstrap reports readiness. Verify the SSH host fingerprint against your instance when prompted. Send a short task in Plan mode, then switch to Agent mode when you want edits or commands.

## Manage the inference process

Run these from the repository directory on Vast:

| Command | Action |
| --- | --- |
| `bash scripts/vast-server.sh` | Install if needed, then start and wait for readiness |
| `bash scripts/vast-server.sh install` | Prepare the private Python environment without starting inference |
| `bash scripts/vast-server.sh preflight` | Check the environment and GPU prerequisites |
| `bash scripts/vast-server.sh status` | Inspect the managed server and readiness |
| `bash scripts/vast-server.sh logs` | Show the last 80 log lines and follow new output; Ctrl+C stops viewing |
| `bash scripts/vast-server.sh stop` | Stop the inference process managed by this checkout |
| `bash scripts/vast-server.sh restart` | Stop and start it with your current environment settings |
| `bash scripts/vast-server.sh help` | Show usage and configuration |

To restart after a configuration change, keep the intended overrides in your environment and run:

```bash
bash scripts/vast-server.sh restart
```

Repeated `start` calls reuse the managed process instead of creating duplicates. An unchanged installation reuses its dependencies; retained model files are reused through the Hugging Face cache. By default, **`.open-anchor-server/`** in this checkout contains `venv/`, `model-cache/`, `server.json`, `server.log`, and a lifecycle lock. Keep this directory on retained instance storage to reuse it across stops.

The default readiness wait is **1,800 seconds after the server launches**; package installation happens before that timer starts. If model download or loading exceeds the wait, or you interrupt the readiness wait with Ctrl+C, the background server remains running. Inspect `status` and `logs`, or use `stop`. For an authenticated endpoint, make the same `VLLM_API_KEY` available when checking readiness; process status can still be inspected without it. Stopping vLLM does not stop the Vast rental or its billing.

## Configuration

Set environment variables in the Vast terminal before starting:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPEN_ANCHOR_MODEL` | `Qwen/Qwen3.8-27B` | Model checkpoint |
| `OPEN_ANCHOR_CONTEXT` | `16384` | Server context limit; match it in the extension |
| `OPEN_ANCHOR_HOST` | `127.0.0.1` | Listen address; `0.0.0.0` enables a mapped public HTTP port |
| `OPEN_ANCHOR_PORT` | `8000` | Port inside the Vast instance |
| `OPEN_ANCHOR_STARTUP_TIMEOUT` | `1800` | Seconds to wait for model readiness |
| `OPEN_ANCHOR_STATE_DIR` | Repository's `.open-anchor-server/` | Private environment, process state, and logs |
| `OPEN_ANCHOR_PYTHON` | `python3.12`, if available; otherwise `python3` | Python executable used to create the private environment |
| `HF_HOME` | State directory's `model-cache/` | Existing Hugging Face cache, if already configured |
| `OPEN_ANCHOR_DTYPE` | `bfloat16` | Model precision |
| `OPEN_ANCHOR_MIN_VRAM_GIB` | `60` | Minimum total GPU memory checked by preflight |
| `VLLM_API_KEY` | Unset | Optional model API bearer key, supplied through the environment |

For example, to use a retained cache and allow a longer first startup:

```bash
export HF_HOME=/workspace/huggingface-cache
export OPEN_ANCHOR_STARTUP_TIMEOUT=3600
bash scripts/vast-server.sh
```

Keep overrides available in the shell or instance environment for subsequent starts or restarts. Changing a variable does not reconfigure an already running process; restart it with the new configuration. If you change `OPEN_ANCHOR_STATE_DIR`, use the same value for later management commands. A lower memory threshold does not make a model fit; select a checkpoint and precision appropriate to the actual GPU. The NVFP4 Docker setup below is a separate profile.

## Optional: connect through a public API address

If your Vast instance already maps the model port, start the bootstrap on all interfaces. Set a model API key for a public endpoint; the following reads it without putting the value in shell history:

```bash
bash scripts/vast-server.sh stop
read -r -s -p 'Model API key: ' VLLM_API_KEY
echo
export VLLM_API_KEY
export OPEN_ANCHOR_HOST=0.0.0.0
bash scripts/vast-server.sh
```

The script does not create Vast port mappings or HTTPS proxies. In Vast's **IP Port Info**, find the public mapping for `8000/tcp`, for example:

```text
203.0.113.10:39871 -> 8000/tcp
```

Select the extension's **Direct HTTP / HTTPS** connection and enter `http://203.0.113.10:39871/v1`, replacing the example address. Use the same model API key and the bootstrap's `16384` context / `4096` output limit. The SSH port from Vast's SSH command is a different service. Vast assigns external ports; internal port 8000 does not imply public port 8000. See [Vast networking](https://docs.vast.ai/guides/instances/connect/networking).

An existing HTTPS proxy URL works if it reaches vLLM and supports streaming. HTTP sends prompts and credentials without encryption; use HTTPS or the default SSH tunnel when available. Preserve any API path prefix. A portal login URL, query-token URL, or SSH proxy address is not a direct inference API; Open Anchor rejects redirects. See [Vast Instance Portal](https://docs.vast.ai/guides/instances/connect/instance-portal).

To check a public API from PowerShell on your computer, set your local `VLLM_API_KEY` to the same value if needed:

```powershell
$anchorBase = 'http://PUBLIC_IP:MAPPED_PORT/v1'
$anchorHeaders = @{}
if ($env:VLLM_API_KEY) { $anchorHeaders.Authorization = "Bearer $env:VLLM_API_KEY" }
Invoke-RestMethod "$anchorBase/models" -Headers $anchorHeaders
```

The response should list `open-anchor`. A timeout can mean loading is incomplete or the port is unreachable. A 401 means the API key does not match. HTML instead of JSON usually means the URL reaches a portal/login page. Check `logs` for GPU memory or model-load errors. If preflight rejects the GPU or driver, use an instance with the required capability; the bootstrap does not modify the host driver.

## Alternative: stock Docker image for RTX 5090 / NVFP4

This is the separate **Blackwell RTX 5090** profile, with a 32K context. It is not the CMP 170HX BF16 bootstrap above. Create a Vast template with:

| Setting | Value |
| --- | --- |
| Docker image | `vllm/vllm-openai:v0.28.0` |
| Launch mode | **Entrypoint** / **docker ENTRYPOINT** |
| Entrypoint override | `vllm` |
| Entrypoint arguments | The line below, beginning with `serve` |
| Docker options | `-p 8000:8000 -e HF_HOME=/workspace/huggingface-cache -e OPEN_BUTTON_PORT=8000` |
| Optional private environment | `VLLM_API_KEY`; `HF_TOKEN` only if your checkpoint requires it |

Paste into the arguments field, separate from the executable override:

```text
serve Inferact/Qwen3.8-27B-NVFP4 --served-model-name open-anchor --host 0.0.0.0 --port 8000 --tensor-parallel-size 1 --max-model-len 32768 --max-num-seqs 1 --enforce-eager --kv-cache-dtype fp8 --language-model-only --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_xml
```

Entrypoint mode runs the image process directly, without a bootstrap SSH session or an on-start script. SSH and Jupyter modes replace its entrypoint. See [Vast connection modes](https://docs.vast.ai/guides/instances/connect/overview) and [template settings](https://docs.vast.ai/guides/templates/template-settings).

The [upstream recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B) documents single-5090 NVFP4 serving at 32K with `--enforce-eager`. This project has not benchmarked that live GPU configuration. Allocate disk for the image and model cache. Wait for the container logs to show readiness, then use its mapped API port with context **`32768`** and output limit **`8192`**. The stock image does not install Vast's Instance Portal or create HTTPS tunnels.

### Alternative: build the supplied worker image

`worker/Dockerfile` packages `scripts/start-vllm.sh` on the pinned vLLM image with the same RTX 5090/NVFP4 defaults. On a machine with a Docker builder, replace `YOUR_REGISTRY`:

```bash
docker build --platform linux/amd64 -f worker/Dockerfile -t YOUR_REGISTRY/open-anchor-worker:0.1.0 .
docker push YOUR_REGISTRY/open-anchor-worker:0.1.0
```

Select that image in Vast with **Entrypoint**, leaving overrides and arguments empty. Keep the model-port mapping and any private API key configuration. `worker/vast-template.json` is a settings reference, not an importable template or API request. The container's local `/health` check allows a 30-minute initial grace period; verify external `/v1/models` separately. Docker build and live startup have not been verified here, and no image has been published by this project.

## Stop the rental

Disconnecting Open Anchor leaves vLLM and the Vast rental running. The bootstrap's `stop` stops only vLLM. Stop or destroy the instance yourself in Vast to end GPU compute charges. Stopped instances preserve data and continue storage charges; destroying removes instance data, including its local model cache. See [Vast instance management](https://docs.vast.ai/guides/instances/manage-instances).
