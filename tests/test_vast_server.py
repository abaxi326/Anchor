"""Linux lifecycle checks with a real HTTP child; no GPU, installs or downloads."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("anchor_vast_server", ROOT / "scripts/vast_server.py")
server = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server
SPEC.loader.exec_module(server)

MOCK_SERVER = r'''
import json, signal, subprocess, sys, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
port, mode, expected_key = int(sys.argv[1]), sys.argv[2], sys.argv[3]
if mode == "exit":
    print("mock model failed to load", flush=True)
    sys.exit(7)
if mode == "wait":
    time.sleep(120)
if mode == "stubborn-child":
    child_file = Path(sys.argv[4])
    subprocess.Popen([sys.executable, "-c",
        "import os,signal,sys,time; from pathlib import Path; "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(120)", str(child_file)])
    while not child_file.exists():
        time.sleep(0.01)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if expected_key and self.headers.get("Authorization") != "Bearer " + expected_key:
            self.send_response(401); self.end_headers(); return
        if self.path != "/v1/models":
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        model = "wrong-model" if mode == "wrong-model" else "open-anchor"
        self.wfile.write(json.dumps({"data": [{"id": model}]}).encode())
    def log_message(self, *args):
        pass
http = ThreadingHTTPServer(("127.0.0.1", port), Handler)
http.serve_forever()
'''


@unittest.skipUnless(sys.platform.startswith("linux"), "Vast process management targets Linux")
class VastServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="open-anchor-server-test-")
        self.root = Path(self.directory.name)
        self.state = self.root / "state"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.environment = patch.dict(os.environ, {
            "OPEN_ANCHOR_STATE_DIR": str(self.state),
            "OPEN_ANCHOR_HOST": "127.0.0.1",
            "OPEN_ANCHOR_PORT": str(self.port),
            "OPEN_ANCHOR_CONTEXT": "16384",
            "OPEN_ANCHOR_MODEL": "Qwen/Qwen3.8-27B",
            "OPEN_ANCHOR_STARTUP_TIMEOUT": "3",
            "VLLM_API_KEY": "",
            "HF_HOME": str(self.root / "model-cache"),
        })
        self.environment.start()
        self.cfg = server.Config.from_env(ROOT)
        self.fake = self.root / "fake_vllm.py"
        self.fake.write_text(MOCK_SERVER)
        self.child_file = self.root / "engine.pid"
        self.mode = "ready"
        self.expected_key = ""
        self.preflight = patch.object(server, "preflight", return_value=None)
        self.install = patch.object(server, "install", return_value=None)
        self.command = patch.object(server, "server_command", side_effect=lambda cfg: [
            sys.executable, str(self.fake), str(self.port), self.mode, self.expected_key, str(self.child_file),
        ])
        self.children = []
        actual_popen = subprocess.Popen
        def remember_child(*args, **kwargs):
            child = actual_popen(*args, **kwargs)
            self.children.append(child)
            return child
        self.popen = patch.object(server.subprocess, "Popen", side_effect=remember_child)
        self.popen.start()
        self.preflight_mock = self.preflight.start()
        self.install_mock = self.install.start()
        self.command.start()
        self.output = io.StringIO()
        self.capture = contextlib.redirect_stdout(self.output)
        self.capture.__enter__()

    def tearDown(self):
        try:
            server.stop(self.cfg)
        finally:
            self.capture.__exit__(None, None, None)
            self.command.stop()
            self.install.stop()
            self.preflight.stop()
            self.popen.stop()
            for child in self.children:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=5)
            self.environment.stop()
            self.directory.cleanup()

    def metadata(self):
        return json.loads((self.state / "server.json").read_text())

    def test_start_reuses_managed_server_and_stop_removes_it(self):
        server.start(self.cfg)
        first = self.metadata()
        with urlopen(f"http://127.0.0.1:{self.port}/v1/models", timeout=2) as response:
            self.assertEqual(json.load(response)["data"][0]["id"], "open-anchor")
        server.start(self.cfg)
        self.assertEqual(self.metadata()["pid"], first["pid"])
        server.stop(self.cfg)
        self.assertIsNone(server.process_identity(first["pid"]))

    def test_restart_can_immediately_reuse_the_same_port(self):
        server.start(self.cfg)
        first_pid = self.metadata()["pid"]
        server.main(["restart"])
        self.assertNotEqual(self.metadata()["pid"], first_pid)
        self.assertEqual(server.status(self.cfg)["state"], "ready")

    def test_occupied_port_is_not_adopted_or_stopped(self):
        with socket.socket() as unrelated:
            unrelated.bind(("127.0.0.1", self.port))
            unrelated.listen()
            with self.assertRaises(Exception):
                server.start(self.cfg)
            server.stop(self.cfg)
            # The unrelated listening socket is still open and owned by this test.
            self.assertNotEqual(unrelated.fileno(), -1)
            self.assertFalse((self.state / "server.json").exists())
            self.preflight_mock.assert_not_called()
            self.install_mock.assert_not_called()

    def test_early_model_crash_is_reported_with_log_available(self):
        self.mode = "exit"
        began = time.monotonic()
        with self.assertRaises(Exception):
            server.start(self.cfg)
        self.assertLess(time.monotonic() - began, 8)
        self.assertIn("mock model failed to load", (self.state / "server.log").read_text())

    def test_timeout_keeps_owned_process_available_to_stop(self):
        self.mode = "wait"
        with self.assertRaises(Exception):
            server.start(self.cfg)
        data = self.metadata()
        self.assertIsNotNone(server.process_identity(data["pid"]))
        server.stop(self.cfg)
        self.assertIsNone(server.process_identity(data["pid"]))

    def test_readiness_requires_expected_served_model(self):
        self.mode = "wrong-model"
        with self.assertRaises(Exception):
            server.start(self.cfg)
        self.assertNotIn("Ready:", self.output.getvalue())

    def test_api_key_used_for_readiness_is_absent_from_state(self):
        self.expected_key = "test-inference-token"
        os.environ["VLLM_API_KEY"] = self.expected_key
        self.cfg = server.Config.from_env(ROOT)
        server.start(self.cfg)
        self.assertNotIn(self.expected_key, (self.state / "server.json").read_text())
        self.assertNotIn(self.expected_key, self.output.getvalue())

    def test_enabling_auth_requires_restart_of_an_unauthenticated_server(self):
        server.start(self.cfg)
        original = self.metadata()
        os.environ["VLLM_API_KEY"] = "new-authentication-key"
        authenticated_cfg = server.Config.from_env(ROOT)
        with self.assertRaisesRegex(RuntimeError, "different|restart|Stop"):
            server.start(authenticated_cfg)
        self.assertEqual(self.metadata()["pid"], original["pid"])

    def test_stop_is_available_while_start_waits_for_readiness(self):
        self.mode = "wait"
        results = []
        def wait_for_start():
            try:
                server.start(self.cfg)
            except RuntimeError as error:
                results.append(str(error))
        starter = threading.Thread(target=wait_for_start)
        starter.start()
        try:
            deadline = time.monotonic() + 5
            while not (self.state / "server.json").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue((self.state / "server.json").exists())
            # Metadata is written just before releasing the startup lock. Give
            # that brief critical section time to finish, while the model is
            # still loading; a lock held across readiness would fail this bound.
            stop_deadline = time.monotonic() + 1
            while True:
                try:
                    server.stop(self.cfg)
                    break
                except RuntimeError as error:
                    if "Another install/start/stop" not in str(error) or time.monotonic() >= stop_deadline:
                        raise
                    time.sleep(0.01)
        finally:
            starter.join(timeout=6)
        self.assertFalse(starter.is_alive())
        self.assertEqual(len(results), 1)

    def test_stop_cleans_up_engine_after_group_leader_exits(self):
        self.mode = "stubborn-child"
        server.start(self.cfg)
        child_pid = int(self.child_file.read_text())
        child_identity = server.process_identity(child_pid)
        self.assertIsNotNone(child_identity)
        try:
            with patch.object(server, "STOP_TIMEOUT", 0.5):
                server.stop(self.cfg)
            deadline = time.monotonic() + 3
            while server.process_identity(child_pid) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNone(server.process_identity(child_pid))
        finally:
            if server.process_identity(child_pid) == child_identity:
                os.kill(child_pid, signal.SIGKILL)

    def test_stale_process_identity_never_kills_an_unrelated_process(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True)
        try:
            # First produce valid metadata, then replace only its PID with another
            # live session leader. Its different /proc start time must reject it.
            server.start(self.cfg)
            data = self.metadata()
            server.stop(self.cfg)
            data["pid"] = unrelated.pid
            data["pgid"] = unrelated.pid
            data["start_time"] = "invalid-old-start-time"
            (self.state / "server.json").write_text(json.dumps(data))
            try:
                server.stop(self.cfg)
            except Exception:
                pass
            self.assertIsNone(unrelated.poll())
        finally:
            if unrelated.poll() is None:
                os.killpg(unrelated.pid, signal.SIGTERM)
            unrelated.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
