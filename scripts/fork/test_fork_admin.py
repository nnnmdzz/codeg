"""fork_admin.py 的測試：假的 codeg（驗 token）、假的 systemctl / journalctl，
經由真正的 unix socket 發 HTTP 請求。不碰真實的 systemd。

  python3 scripts/fork/test_fork_admin.py
"""

from __future__ import annotations

import http.client
import http.server
import importlib
import json
import os
import socket
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path

GOOD = "Bearer good-token"

FAKE_SYSTEMCTL = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import os, sys, uuid
    state = os.environ["FAKE_STATE"]
    args = sys.argv[1:]
    with open(os.environ["FAKE_CALLS"], "a") as f:
        f.write(" ".join(args) + "\\n")
    if args[0] == "show":
        print(open(state).read(), end="")
    elif args[0] == "start":
        open(state, "w").write(
            "ActiveState=activating\\nResult=success\\n"
            f"InvocationID={uuid.uuid4().hex}\\n"
            "ExecMainStartTimestamp=@1000\\nExecMainExitTimestamp=\\n"
        )
    """
)

FAKE_JOURNALCTL = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import os, sys
    with open(os.environ["FAKE_CALLS"], "a") as f:
        f.write("journalctl " + " ".join(sys.argv[1:]) + "\\n")
    print(open(os.environ["FAKE_JOURNAL"]).read(), end="")
    """
)


class FakeCodeg(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        ok = self.path == "/api/health" and self.headers["Authorization"] == GOOD
        body = json.dumps({"status": "ok", "version": "0.32.3"}).encode()
        self.send_response(200 if ok else 401)
        self.end_headers()
        if ok:
            self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str) -> None:
        super().__init__("localhost", timeout=10)
        self.unix_path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.unix_path)


class ForkAdminTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())
        bin_dir = cls.tmp / "bin"
        bin_dir.mkdir()
        for name, body in (("systemctl", FAKE_SYSTEMCTL), ("journalctl", FAKE_JOURNALCTL)):
            script = bin_dir / name
            script.write_text(body)
            script.chmod(0o755)
        web = cls.tmp / "web-fork"
        web.mkdir()
        (web / ".fork-build").write_text("v0.32.2\nc9790499\n2026-09-25T23:59:48-07:00\n")

        cls.codeg = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeCodeg)
        threading.Thread(target=cls.codeg.serve_forever, daemon=True).start()

        os.environ.update(
            PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            FAKE_STATE=str(cls.tmp / "state"),
            FAKE_CALLS=str(cls.tmp / "calls"),
            FAKE_JOURNAL=str(cls.tmp / "journal"),
            CODEG_URL=f"http://127.0.0.1:{cls.codeg.server_address[1]}",
            CODEG_FORK_WEB_DIR=str(web),
        )
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(Path(__file__).parent))
        cls.admin = importlib.import_module("fork_admin")
        cls.socket_path = str(cls.tmp / "run" / "admin.sock")
        cls.server = cls.admin.serve(cls.socket_path)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.codeg.shutdown()

    def setUp(self) -> None:
        self.set_state(
            "ActiveState=inactive\nResult=success\n"
            "InvocationID=55c5e1a32e014a1589a299fa4545d60e\n"
            "ExecMainStartTimestamp=@1790731494\nExecMainExitTimestamp=@1790731494\n"
        )
        Path(os.environ["FAKE_JOURNAL"]).write_text("")
        Path(os.environ["FAKE_CALLS"]).write_text("")

    def set_state(self, text: str) -> None:
        Path(os.environ["FAKE_STATE"]).write_text(text)

    def calls(self) -> list[str]:
        return Path(os.environ["FAKE_CALLS"]).read_text().splitlines()

    def request(self, method: str, path: str, auth: str | None = GOOD):
        conn = UnixConnection(self.socket_path)
        headers = {"Authorization": auth} if auth else {}
        conn.request(method, path, headers=headers)
        res = conn.getresponse()
        body = json.loads(res.read() or b"{}")
        conn.close()
        return res, body

    def test_socket_is_reachable_by_non_root(self) -> None:
        self.assertEqual(os.stat(self.socket_path).st_mode & 0o777, 0o666)

    def test_rejects_missing_and_wrong_tokens(self) -> None:
        for auth in (None, "Bearer wrong", "Basic abc"):
            res, _ = self.request("GET", "/status", auth)
            self.assertEqual(res.status, 401, auth)
        res, _ = self.request("POST", "/update", "Bearer wrong")
        self.assertEqual(res.status, 401)
        self.assertFalse(any(c.startswith("start") for c in self.calls()))

    def test_status_reports_versions_and_idle_updater(self) -> None:
        res, body = self.request("GET", "/status")
        self.assertEqual(res.status, 200)
        self.assertEqual(res.getheader("Cache-Control"), "no-store")
        self.assertEqual(body["server"], "0.32.3")
        self.assertEqual(body["built"], "0.32.2")
        self.assertEqual(body["commit"], "c9790499")
        self.assertEqual(body["updater"]["state"], "idle")
        self.assertEqual(body["updater"]["log"], [])

    def test_update_starts_the_unit_and_reports_running(self) -> None:
        Path(os.environ["FAKE_JOURNAL"]).write_text(
            "server v0.32.3, fork web built for v0.32.2 — updating\n"
        )
        res, body = self.request("POST", "/update")
        self.assertEqual(res.status, 202)
        self.assertIn(
            "start --no-block --no-ask-password codeg-web-fork-update.service",
            self.calls(),
        )
        self.assertEqual(body["updater"]["state"], "running")
        self.assertIsNone(body["updater"]["finishedAt"])
        self.assertEqual(
            body["updater"]["log"],
            ["server v0.32.3, fork web built for v0.32.2 — updating"],
        )

    def test_failed_run_includes_its_log_without_ansi(self) -> None:
        self.set_state(
            "ActiveState=failed\nResult=exit-code\n"
            "InvocationID=0123456789abcdef0123456789abcdef\n"
            "ExecMainStartTimestamp=@100\nExecMainExitTimestamp=@160\n"
        )
        Path(os.environ["FAKE_JOURNAL"]).write_text(
            "\x1b[31mrebase stopped on a conflict.\x1b[0m\n"
        )
        _, body = self.request("GET", "/status")
        self.assertEqual(body["updater"]["state"], "failed")
        self.assertEqual(body["updater"]["finishedAt"], 160)
        self.assertEqual(body["updater"]["log"], ["rebase stopped on a conflict."])
        self.assertIn(
            "journalctl _SYSTEMD_INVOCATION_ID=0123456789abcdef0123456789abcdef"
            " --output=cat --no-pager --lines=12",
            self.calls(),
        )

    def test_malformed_invocation_id_is_never_passed_to_journalctl(self) -> None:
        self.set_state("ActiveState=failed\nResult=exit-code\nInvocationID=--all\n")
        _, body = self.request("GET", "/status")
        self.assertEqual(body["updater"]["log"], [])
        self.assertFalse(any(c.startswith("journalctl") for c in self.calls()))

    def test_unknown_paths_and_methods_are_not_found(self) -> None:
        self.assertEqual(self.request("GET", "/update")[0].status, 404)
        self.assertEqual(self.request("POST", "/status")[0].status, 404)
        self.assertEqual(self.request("GET", "/../etc/passwd")[0].status, 404)

    def test_codeg_down_is_a_bad_gateway(self) -> None:
        url = self.admin.CODEG_URL
        self.admin.CODEG_URL = "http://127.0.0.1:9"  # 沒人在聽
        try:
            res, _ = self.request("GET", "/status")
        finally:
            self.admin.CODEG_URL = url
        self.assertEqual(res.status, 502)


if __name__ == "__main__":
    unittest.main(verbosity=2)
