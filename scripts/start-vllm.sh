#!/usr/bin/env bash
# Inference worker entrypoint: downloads/loads the model and serves its API.
# This script never rents, starts, stops, or destroys a Vast.ai instance.
set -euo pipefail
anchor_model="${OPEN_ANCHOR_MODEL:-Inferact/Qwen3.8-27B-NVFP4}"
anchor_context="${OPEN_ANCHOR_CONTEXT:-32768}"
anchor_host="${OPEN_ANCHOR_HOST:-0.0.0.0}"
anchor_port="${OPEN_ANCHOR_PORT:-8000}"
export HF_HOME="${HF_HOME:-/workspace/huggingface-cache}"
mkdir -p "$HF_HOME"
exec vllm serve "$anchor_model" \
  --served-model-name open-anchor \
  --host "$anchor_host" --port "$anchor_port" \
  --tensor-parallel-size 1 \
  --max-model-len "$anchor_context" \
  --max-num-seqs 1 \
  --enforce-eager \
  --kv-cache-dtype fp8 \
  --language-model-only \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml \
  "$@"
