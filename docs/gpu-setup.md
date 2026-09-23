# Vast.ai inference worker

Vast runs **vLLM and the model**. The extension runs **Pi and its coding tools beside VS Code**, using your local workspace. Connect with an API URL and an optional model API key. There is no repository upload step; prompts and file contents used as model context are sent to the inference API.

## Stock image: no build or SSH required

Create a Vast template with these settings:

| Setting | Value |
| --- | --- |
| Docker image | `vllm/vllm-openai:v0.28.0` |
| Launch mode | **Entrypoint** / **docker ENTRYPOINT** |
| Entrypoint override | `vllm` |
| Entrypoint arguments | The line below, beginning with `serve` |
| Docker options | `-p 8000:8000 -e HF_HOME=/workspace/huggingface-cache -e OPEN_BUTTON_PORT=8000` |
| Optional private environment | `VLLM_API_KEY` for model API authentication; `HF_TOKEN` only if your checkpoint requires it |

Paste into the **arguments** field, separate from the `vllm` executable override:

```text
serve Inferact/Qwen3.8-27B-NVFP4 --served-model-name open-anchor --host 0.0.0.0 --port 8000 --tensor-parallel-size 1 --max-model-len 32768 --max-num-seqs 1 --enforce-eager --kv-cache-dtype fp8 --language-model-only --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_xml
```

Entrypoint mode runs the configured image process directly. SSH and Jupyter modes replace its entrypoint. This setup needs no on-start script. See [Vast connection modes](https://docs.vast.ai/guides/instances/connect/overview) and [template settings](https://docs.vast.ai/guides/templates/template-settings).

The default targets **one RTX 5090 / Blackwell GPU** with a compatible NVIDIA driver. The [upstream Qwen3.8-27B recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B) documents single-5090 NVFP4 serving at 32K context with `--enforce-eager`. This project has not benchmarked a live GPU; this configuration does not imply compatibility with every GPU. Allocate disk for both the container image and model cache.

Rent/start the instance manually. Its container automatically downloads the checkpoint into `HF_HOME`, loads it, and starts the API. Watch Vast's container logs until the model is ready. Subsequent starts can reuse cached files when the same storage is retained. A running container does not mean the model has finished loading.

Set `VLLM_API_KEY` to restrict access to a public model endpoint; keep it in private/account environment settings. Direct HTTP sends prompts and credentials without encryption; use HTTPS when available.

## Find the URL and connect

In Vast's **IP Port Info**, find the public mapping for **`8000/tcp`**. For example:

```text
203.0.113.10:39871 -> 8000/tcp
```

Use `http://203.0.113.10:39871/v1` in Open Anchor, replacing those example values. Vast assigns external ports: `-p 8000:8000` does not promise public port 8000. `OPEN_BUTTON_PORT` only points the Open button at that mapping. See [Vast networking](https://docs.vast.ai/guides/instances/connect/networking).

An existing HTTPS proxy/tunnel URL also works if it reaches the vLLM API and supports streaming. Preserve any API path prefix. The stock image does **not** install Vast's Instance Portal or automatically create HTTPS tunnels. Portal-enabled templates can create tunnels, but a browser login URL with a token query is not automatically an API endpoint. Open Anchor requires a direct HTTP(S) API URL without login-query parameters or redirects; an SSH proxy port is not an HTTP API. See [Instance Portal](https://docs.vast.ai/guides/instances/connect/instance-portal).

Check from your computer with PowerShell. If authentication is enabled, put the same key in your local `VLLM_API_KEY` environment variable:

```powershell
$anchorBase = 'http://PUBLIC_IP:MAPPED_PORT/v1'
$anchorHeaders = @{}
if ($env:VLLM_API_KEY) { $anchorHeaders.Authorization = "Bearer $env:VLLM_API_KEY" }
Invoke-RestMethod "$anchorBase/models" -Headers $anchorHeaders
```

The response should list `open-anchor`. Select the direct API connection in the extension, enter that API URL, model `open-anchor`, context `32768`, output limit `8192`, and the matching API key if configured. Connect and send a short prompt, then try Plan mode on a workspace file.

A timeout can mean the model is loading or the port is unreachable. A 401 means authentication does not match. HTML instead of JSON usually means the URL reaches a portal/login page. Check container logs for GPU-memory or model-load errors.

## Alternative: your own worker image

[worker/Dockerfile](../worker/Dockerfile) packages [scripts/start-vllm.sh](../scripts/start-vllm.sh) on the same pinned vLLM image. With a Docker builder running, replace `YOUR_REGISTRY` with your registry/namespace:

```bash
docker build --platform linux/amd64 -f worker/Dockerfile -t YOUR_REGISTRY/open-anchor-worker:0.1.0 .
docker push YOUR_REGISTRY/open-anchor-worker:0.1.0
```

Select that image in Vast, choose **Entrypoint**, and leave the override and arguments **empty**. Keep `-p 8000:8000` and any private API key configuration. Supply registry credentials in Vast for a private image.

[worker/vast-template.json](../worker/vast-template.json) is a settings reference to copy into Vast's editor, **not an importable template or Vast API request**. The script accepts `OPEN_ANCHOR_MODEL`, `OPEN_ANCHOR_CONTEXT`, `OPEN_ANCHOR_HOST`, `OPEN_ANCHOR_PORT`, and `HF_HOME`, and forwards extra arguments to vLLM. Change ports through the environment variable and update the Vast mapping to match.

The custom image checks local `/health`, allowing a 30-minute initial grace period for loading. Verify external `/v1/models` separately for networking and authentication. Its build context includes only the Dockerfile and launch script, without workspace files or keys. Docker build and live GPU startup have **not** been verified here; no image has been published and no instance has been rented by this project.

## Stop the rental

Disconnecting Open Anchor does not stop Vast or vLLM. Stop or destroy the instance yourself. Stopping preserves data and can continue storage charges; destroying removes instance data, including its local model cache. See [Vast instance management](https://docs.vast.ai/guides/instances/manage-instances).
