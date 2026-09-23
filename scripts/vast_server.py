"""Manage one local vLLM process inside an existing Linux GPU instance."""
import csv
import ipaddress
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

VERSION = "0.28.0+cu129"
WHEEL = "https://github.com/vllm-project/vllm/releases/download/v0.28.0/vllm-0.28.0%2Bcu129-cp38-abi3-manylinux_2_28_x86_64.whl"
DEFAULT_MODEL = "Qwen/Qwen3.8-27B"
STOP_TIMEOUT = 20


@dataclass(frozen=True)
class Config:
    state: Path
    model: str = DEFAULT_MODEL
    context: int = 16384
    host: str = "127.0.0.1"
    port: int = 8000
    timeout: float = 1800
    dtype: str = "bfloat16"
    min_vram_gib: float = 60
    cache: Path | None = None
    api_key: str = ""

    @classmethod
    def from_env(cls, repo_root=None):
        root = Path(repo_root or Path(__file__).resolve().parents[1])
        env = os.environ
        state = Path(env.get("OPEN_ANCHOR_STATE_DIR", str(root / ".open-anchor-server"))).expanduser().resolve()
        model = env.get("OPEN_ANCHOR_MODEL", DEFAULT_MODEL).strip()
        cfg = cls(state, model, int(env.get("OPEN_ANCHOR_CONTEXT", "16384")),
                  env.get("OPEN_ANCHOR_HOST", "127.0.0.1"), int(env.get("OPEN_ANCHOR_PORT", "8000")),
                  float(env.get("OPEN_ANCHOR_STARTUP_TIMEOUT", "1800")), env.get("OPEN_ANCHOR_DTYPE", "bfloat16"),
                  float(env.get("OPEN_ANCHOR_MIN_VRAM_GIB", "60")),
                  Path(env.get("HF_HOME", str(state / "model-cache"))).expanduser().resolve(), env.get("VLLM_API_KEY", ""))
        if not model or cfg.context < 4096 or not 1 <= cfg.port <= 65535 or cfg.timeout <= 0 or cfg.min_vram_gib < 0:
            raise RuntimeError("Invalid model, context, port, timeout, or minimum VRAM setting.")
        if cfg.host != "localhost":
            ipaddress.ip_address(cfg.host)
        if cfg.dtype not in {"auto", "bfloat16", "float16"}:
            raise RuntimeError("OPEN_ANCHOR_DTYPE must be auto, bfloat16, or float16.")
        return cfg

    @property
    def python(self):
        return self.state / "venv" / "bin" / "python"

    @property
    def log(self):
        return self.state / "server.log"


@contextmanager
def lifecycle_lock(cfg):
    import fcntl
    cfg.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (cfg.state / "lifecycle.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another install/start/stop is active. Try again after it finishes.") from None
        yield


def process_identity(pid):
    try:
        proc = Path("/proc") / str(int(pid))
        fields = (proc / "stat").read_text().rpartition(")")[2].split()
        if fields[0] == "Z":
            return None
        return {"pid": int(pid), "start_time": fields[19], "pgid": int(fields[2]), "uid": proc.stat().st_uid}
    except (OSError, ValueError, IndexError, TypeError):
        return None


def same_process(record):
    identity = process_identity(record.get("pid"))
    return bool(identity and identity["pgid"] == identity["pid"] and identity["uid"] == os.getuid()
                and all(record.get(key) == value for key, value in identity.items()))


def member_matches(member):
    current = process_identity(member.get("pid"))
    return bool(current and current["uid"] == os.getuid() and all(member.get(key) == value for key, value in current.items()))


def managed_members(record):
    anchors = [record, *record.get("members", [])]
    anchors = [{key: member[key] for key in ("pid", "start_time", "pgid", "uid")}
               for member in anchors if member_matches(member) and member.get("pgid") == record.get("pgid")]
    if not anchors:
        return []
    members = [process_identity(proc.name) for proc in Path("/proc").iterdir() if proc.name.isdecimal()]
    members = [member for member in members if member and member["pgid"] == record["pgid"] and member["uid"] == os.getuid()]
    # A still-matching anchor prevents adopting a recycled process-group number.
    return members if any(anchor in members for anchor in anchors) else []


def save_record(cfg, record):
    temporary = cfg.state / "server.json.tmp"
    temporary.write_text(json.dumps(record) + "\n")
    temporary.chmod(0o600)
    temporary.replace(cfg.state / "server.json")


def remember_members(cfg, record):
    try:
        with lifecycle_lock(cfg):
            current = read_record(cfg)
            if any(current.get(key) != record.get(key) for key in ("pid", "start_time", "pgid", "uid")):
                return
            members = managed_members(record)
            if members:
                record["members"] = members
                save_record(cfg, record)
    except RuntimeError:  # A concurrent stop/install owns the lock.
        pass


def read_record(cfg):
    try:
        record = json.loads((cfg.state / "server.json").read_text())
        return record if isinstance(record, dict) else {}
    except (OSError, ValueError):
        return {}


def probe_host(host):
    return {"0.0.0.0": "127.0.0.1", "localhost": "127.0.0.1", "::": "::1"}.get(host, host)


def api_url(record):
    host = probe_host(record["host"])
    return f"http://{'[' + host + ']' if ':' in host else host}:{record['port']}/v1"


def ensure_port_free(cfg):
    family = socket.AF_INET6 if ":" in cfg.host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            # Match the API server's bind behavior: recently closed HTTP
            # connections may remain in TIME_WAIT after a clean restart.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((cfg.host, cfg.port))
    except OSError as error:
        raise RuntimeError(f"Cannot bind {cfg.host}:{cfg.port}: {error}. No process was stopped. Choose another OPEN_ANCHOR_PORT or inspect the existing listener.") from None


def owned_listener(record):
    """Verify the listening socket belongs to this process group before sending a key."""
    if not same_process(record):
        return False
    inodes = set()
    target = ipaddress.ip_address(probe_host(record["host"]))
    for table in ("tcp", "tcp6"):
        try:
            lines = Path(f"/proc/net/{table}").read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            address, port = fields[1].split(":")
            if fields[3] != "0A" or int(port, 16) != record["port"]:
                continue
            raw = bytes.fromhex(address)
            local = ipaddress.ip_address(b"".join(raw[i:i + 4][::-1] for i in range(0, len(raw), 4)))
            if local.version == target.version and (local.is_unspecified or local == target):
                inodes.add(f"socket:[{fields[9]}]")
    if not inodes:
        return False
    for proc in Path("/proc").iterdir():
        if not proc.name.isdecimal():
            continue
        identity = process_identity(proc.name)
        if not identity or identity["pgid"] != record["pgid"] or identity["uid"] != record["uid"]:
            continue
        try:
            if any(os.readlink(fd) in inodes for fd in (proc / "fd").iterdir()):
                return same_process(record)
        except OSError:
            continue
    return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def probe(record, cfg):
    if not owned_listener(record):
        return "loading", "Waiting for the managed API listener."
    headers = {"Authorization": "Bearer " + cfg.api_key} if cfg.api_key else {}
    request = urllib.request.Request(api_url(record) + "/models", headers=headers)
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=3) as response:
            models = json.loads(response.read(1024 * 1024)).get("data", [])
        if any(model.get("id") == "open-anchor" for model in models):
            return "ready", "Model API is ready."
        return "loading", "API has not listed the open-anchor model yet."
    except urllib.error.HTTPError as error:
        return ("auth-required", "Set the same VLLM_API_KEY used when starting the server.") if error.code in (401, 403) else ("loading", f"API returned HTTP {error.code}.")
    except (OSError, ValueError, TypeError, AttributeError):
        return "loading", "Model API is not ready yet."


def status(cfg):
    record = read_record(cfg)
    if not record:
        return {"state": "stopped", "detail": "No managed server is recorded.", "log": str(cfg.log)}
    if not same_process(record):
        if managed_members(record):
            return {**record, "state": "orphaned", "detail": "The API parent exited but verified managed workers remain. Run stop to clean them up.", "log": str(cfg.log)}
        return {"state": "stale", "detail": "The recorded process is gone or its identity changed; no process was signalled.", "log": str(cfg.log)}
    remember_members(cfg, record)
    state, detail = probe(record, cfg)
    return {**record, "state": state, "detail": detail, "url": api_url(record), "log": str(cfg.log)}


def preflight(cfg):
    if sys.platform != "linux" or platform.machine() != "x86_64" or not (3, 10) <= sys.version_info[:2] < (3, 15):
        raise RuntimeError("Use Linux x86_64 with Python 3.10–3.14 (3.12 recommended) inside your Vast instance.")
    result = subprocess.run(["nvidia-smi", "--query-gpu=index,uuid,name,memory.total,driver_version", "--format=csv,noheader,nounits"], capture_output=True, text=True, check=True)
    rows = list(csv.reader(result.stdout.splitlines(), skipinitialspace=True))
    visible = os.environ.get("CUDA_VISIBLE_DEVICES")
    if visible is not None:
        first = visible.split(",")[0].strip()
        rows = [row for row in rows if first and first in (row[0], row[1])]
    if not rows:
        raise RuntimeError("No usable NVIDIA GPU is visible. Check nvidia-smi and CUDA_VISIBLE_DEVICES.")
    _, _, name, memory, driver = rows[0]
    if tuple(int(part) for part in driver.split(".")) < (575, 57, 8):
        raise RuntimeError(f"Driver {driver} is older than this CUDA 12.9 setup's baseline 575.57.08. Use a host with a compatible driver; this script never installs drivers.")
    if float(memory) < cfg.min_vram_gib * 1024:
        raise RuntimeError(f"{name} has {float(memory) / 1024:.1f} GiB VRAM; this configuration requires {cfg.min_vram_gib:g} GiB. Check actual GPU memory, or select a smaller model and an appropriate OPEN_ANCHOR_MIN_VRAM_GIB.")
    cfg.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache = cfg.cache or cfg.state / "model-cache"
    cache.mkdir(parents=True, exist_ok=True)
    print(f"GPU: {name}; {float(memory) / 1024:.1f} GiB; driver {driver}.", flush=True)
    if shutil.disk_usage(cache).free < 100 * 1024 ** 3:
        print("Disk note: less than 100 GiB free at the model cache. A first BF16 download plus packages needs substantial space; an existing cache may be sufficient.", flush=True)


def installed(cfg):
    if not cfg.python.exists():
        return False
    check = subprocess.run([str(cfg.python), "-c", "import importlib.metadata as m,torch; print(m.version('vllm')); print(torch.version.cuda)"], capture_output=True, text=True)
    return check.returncode == 0 and check.stdout.strip().splitlines() == [VERSION, "12.9"]


def install(cfg):
    if not installed(cfg):
        if managed_members(read_record(cfg)):
            raise RuntimeError("Stop the managed server before changing its Python environment.")
        print("Installing pinned vLLM CUDA 12.9 into the isolated environment…", flush=True)
        if not cfg.python.exists():
            subprocess.run([sys.executable, "-m", "venv", str(cfg.state / "venv")], check=True)
        subprocess.run([str(cfg.python), "-m", "pip", "install", "--upgrade", "pip", "uv"], check=True)
        subprocess.run([str(cfg.python), "-m", "uv", "pip", "install", "--python", str(cfg.python), WHEEL, "--torch-backend=cu129"], check=True)
        if not installed(cfg):
            raise RuntimeError("Installed packages do not match vLLM 0.28.0+cu129 and PyTorch CUDA 12.9.")
    else:
        print("Reusing the pinned vLLM environment.", flush=True)
    code = "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable'; print('CUDA GPU:',torch.cuda.get_device_name(0)); "
    code += f"assert torch.cuda.get_device_properties(0).total_memory >= {cfg.min_vram_gib * 1024 ** 3!r}, 'Selected CUDA device has insufficient VRAM'; "
    if cfg.dtype == "bfloat16":
        code += "assert torch.cuda.get_device_capability(0)[0] >= 8, 'BF16 requires an Ampere or newer CUDA GPU'; "
    dtype = "bfloat16" if cfg.dtype == "bfloat16" else "float16"
    code += f"x=torch.ones((16,16), device='cuda', dtype=torch.{dtype}); y=x@x; torch.cuda.synchronize(); print('CUDA {dtype} matrix check passed.')"
    subprocess.run([str(cfg.python), "-c", code], check=True)


def server_command(cfg):
    return [str(cfg.state / "venv" / "bin" / "vllm"), "serve", cfg.model,
            "--served-model-name", "open-anchor", "--host", cfg.host, "--port", str(cfg.port),
            "--dtype", cfg.dtype, "--tensor-parallel-size", "1", "--max-model-len", str(cfg.context),
            "--max-num-seqs", "1", "--max-num-batched-tokens", "2048", "--enforce-eager",
            "--kv-cache-dtype", "auto", "--language-model-only", "--reasoning-parser", "qwen3",
            "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_xml"]


def start(cfg):
    with lifecycle_lock(cfg):
        record = read_record(cfg)
        if same_process(record):
            if any(record.get(key) != getattr(cfg, key) for key in ("model", "context", "host", "port", "dtype")) or record.get("api_key_required", False) != bool(cfg.api_key):
                raise RuntimeError("A managed server is running with different settings. Stop it before starting the new configuration.")
            print("The managed server is already running; checking readiness.", flush=True)
        else:
            if managed_members(record):
                raise RuntimeError("The previous API parent exited but managed GPU workers remain. Run stop before starting again.")
            ensure_port_free(cfg)
            preflight(cfg)
            install(cfg)
            ensure_port_free(cfg)
            env = dict(os.environ, HF_HOME=str(cfg.cache or cfg.state / "model-cache"), PYTHONUNBUFFERED="1")
            if cfg.api_key:
                env["VLLM_API_KEY"] = cfg.api_key
            else:
                env.pop("VLLM_API_KEY", None)
            with cfg.log.open("a") as log:
                log.write(f"\n--- Open Anchor server start {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
                log.flush()
                child = subprocess.Popen(server_command(cfg), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                         env=env, start_new_session=True, close_fds=True)
            record = process_identity(child.pid)
            if not record:
                raise RuntimeError(f"Server exited immediately. Read {cfg.log}.")
            record.update({key: getattr(cfg, key) for key in ("model", "context", "host", "port", "dtype")})
            record["api_key_required"] = bool(cfg.api_key)
            record["members"] = managed_members(record)
            try:
                save_record(cfg, record)
            except OSError:
                if same_process(record):
                    os.killpg(record["pgid"], signal.SIGTERM)
                raise
            print(f"Started managed process {record['pid']}. Log: {cfg.log}", flush=True)
    # Release the lifecycle lock before waiting so another shell can stop loading.
    deadline, next_notice = time.monotonic() + cfg.timeout, 0
    try:
        while time.monotonic() < deadline:
            remember_members(cfg, record)
            if not same_process(record):
                raise RuntimeError(f"Managed server stopped before becoming ready. Read {cfg.log}; check GPU memory, package/driver compatibility, and disk space.")
            state, detail = probe(record, cfg)
            if state == "ready":
                return status(cfg)
            if state == "auth-required":
                raise RuntimeError(f"{detail} The managed process remains running. Use status/logs/stop.")
            if time.monotonic() >= next_notice:
                print(f"Waiting for model: {detail}", flush=True)
                next_notice = time.monotonic() + 15
            time.sleep(min(2, max(0, deadline - time.monotonic())))
    except KeyboardInterrupt:
        raise RuntimeError("Stopped waiting; the managed server remains running. Use status, logs, or stop.") from None
    raise RuntimeError(f"Readiness timed out after {cfg.timeout:g}s; the managed server remains running/loading. Use status or logs, or stop it explicitly. Log: {cfg.log}")


def stop(cfg):
    with lifecycle_lock(cfg):
        record = read_record(cfg)
        members = managed_members(record)
        if not members:
            print("No matching managed process to stop; unrelated processes were left alone.")
            return
        record["members"] = members
        save_record(cfg, record)
        for member in members:
            if member_matches(member):
                try:
                    os.kill(member["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + STOP_TIMEOUT
        while members and time.monotonic() < deadline:
            time.sleep(0.2)
            members = managed_members(record)
            if members:
                record["members"] = members
        for member in members:
            if member_matches(member):
                try:
                    os.kill(member["pid"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 3
        while managed_members(record) and time.monotonic() < deadline:
            time.sleep(0.1)
        if managed_members(record):
            save_record(cfg, record)
            raise RuntimeError("Some managed workers have not exited. Metadata retained; inspect logs and retry stop.")
        (cfg.state / "server.json").unlink(missing_ok=True)
        print("Stopped the managed server.")


def show_status(result):
    print(f"Server: {result['state']}. {result['detail']}")
    if "url" in result:
        print(f"API: {result['url']} | Model: open-anchor | Context: {result['context']} | Output limit: 4096")
        print(f"SSH connection: model server port {result['port']}. GPU checkpoint: {result['model']}.")
    print(f"Log: {result['log']}")


def main(argv=None):
    action = (argv if argv is not None else sys.argv[1:]) or ["start"]
    if action in (["help"], ["--help"], ["-h"]):
        print("Usage: bash scripts/vast-server.sh [start|install|preflight|status|logs|stop|restart]\n"
              "Default: start. Commands manage vLLM inside this existing instance; no Vast billing/lifecycle actions.\n"
              "Environment: OPEN_ANCHOR_STATE_DIR, OPEN_ANCHOR_MODEL, OPEN_ANCHOR_CONTEXT, OPEN_ANCHOR_HOST,\n"
              "OPEN_ANCHOR_PORT, OPEN_ANCHOR_STARTUP_TIMEOUT, OPEN_ANCHOR_DTYPE, OPEN_ANCHOR_MIN_VRAM_GIB,\n"
              "HF_HOME, VLLM_API_KEY, OPEN_ANCHOR_PYTHON (shell launcher). No .env files are sourced.\n"
              "Defaults: Qwen/Qwen3.8-27B BF16, 16384 context, 127.0.0.1:8000, 1800s readiness wait,\n"
              "60 GiB minimum GPU memory, repo/.open-anchor-server state and model-cache.\n"
              "Timeout/Ctrl-C while waiting leaves the background server running. logs follows output.\n"
              "restart uses the current environment; repeat any desired overrides/API key.")
        return 0
    if len(action) != 1 or action[0] not in {"start", "install", "preflight", "status", "logs", "stop", "restart"}:
        raise RuntimeError("Unknown command. Use help.")
    cfg = Config.from_env()
    if action[0] == "start":
        show_status(start(cfg))
    elif action[0] == "install":
        with lifecycle_lock(cfg):
            preflight(cfg)
            install(cfg)
    elif action[0] == "preflight":
        preflight(cfg)
    elif action[0] == "status":
        result = status(cfg)
        show_status(result)
        return 0 if result["state"] == "ready" else 1
    elif action[0] == "stop":
        stop(cfg)
    elif action[0] == "restart":
        stop(cfg)
        show_status(start(cfg))
    elif cfg.log.exists():
        try:
            subprocess.run(["tail", "-n", "80", "-F", str(cfg.log)], check=True)
        except KeyboardInterrupt:
            return 0
    else:
        print(f"No server log yet: {cfg.log}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Open Anchor: {error}", file=sys.stderr)
        sys.exit(1)
