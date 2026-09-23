# Build from the repository root: docker build -f worker/Dockerfile -t open-anchor-worker:0.1.0 .
FROM vllm/vllm-openai:v0.28.0

ENV HF_HOME=/workspace/huggingface-cache \
    OPEN_ANCHOR_MODEL=Inferact/Qwen3.8-27B-NVFP4 \
    OPEN_ANCHOR_CONTEXT=32768 \
    OPEN_ANCHOR_HOST=0.0.0.0 \
    OPEN_ANCHOR_PORT=8000

COPY scripts/start-vllm.sh /opt/open-anchor/start-vllm.sh
# Checkouts created on Windows can have CRLF; normalize the container entrypoint.
RUN sed -i 's/\r$//' /opt/open-anchor/start-vllm.sh && chmod 755 /opt/open-anchor/start-vllm.sh
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30m --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('OPEN_ANCHOR_PORT','8000')+'/health',timeout=4).close()"
ENTRYPOINT ["/bin/bash", "/opt/open-anchor/start-vllm.sh"]
CMD []
