"""jev CLI tests: run bin/jev as a subprocess against a stub SystemOne server.

python3 -m unittest discover shared/jev   (no network, no real secrets)
JEV_LIVE=1 adds a smoke test against the real endpoint and credentials.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
JEV = HERE / "bin" / "jev"
KEY = "test-key-do-not-print"


def answer(p_yes, p_no, confidence):
    return {
        "answers": {
            "q": {
                "type": "noul",
                "noul": p_yes,
                "probabilities": {"yes": p_yes, "no": p_no},
                "confidence": confidence,
            }
        }
    }


class StubHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.requests.append({"path": self.path, "headers": self.headers, "body": raw})
        r = self.server.reply
        time.sleep(r.get("delay", 0))
        body = r["body"] if isinstance(r["body"], bytes) else json.dumps(r["body"]).encode()
        self.send_response(r.get("status", 200))
        if "location" in r:
            self.send_header("Location", r["location"])
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(r.get("length", len(body))))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # only reached if jev follows a redirect
        self.server.requests.append({"path": self.path, "headers": self.headers, "body": b""})
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


class StubServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # the client hung up (timeout test); nothing to report


class JevCLI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = StubServer(("127.0.0.1", 0), StubHandler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.server.requests = []
        self.server.reply = {"body": answer(0.9, 0.1, 0.8)}
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.home = Path(home.name)
        self.mimir = self.home / ".config" / "mimir"
        self.mimir.mkdir(parents=True)
        (self.mimir / "api-key").write_text(KEY + "\n")
        port = self.server.server_address[1]
        (self.mimir / "base-url").write_text(f"http://127.0.0.1:{port}/v1/\n")

    def jev(self, *args, stdin="", timeout=None):
        env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower()}
        env["HOME"] = str(self.home)
        cmd = [sys.executable, str(JEV)]
        if timeout is not None:  # same CLI, with the request timeout shortened
            cmd = [sys.executable, "-c", f"import sys; sys.path.insert(0, {str(HERE)!r}); "
                   f"import jev; jev.TIMEOUT = {timeout}; jev.main()"]
        return subprocess.run(cmd + list(args), input=stdin, env=env,
                              capture_output=True, text=True, timeout=20)

    def assertNoAnswer(self, res):
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertEqual(res.stdout, "")
        self.assertNotIn(KEY, res.stderr)

    def test_ask_request_on_the_wire(self):
        self.jev("ask", "Is it about pasta?", "-t", "A post about the weather.")
        [req] = self.server.requests
        self.assertEqual(req["path"], "/v1/systemone")
        self.assertEqual(req["headers"]["Authorization"], f"Bearer {KEY}")
        self.assertEqual(req["headers"]["Content-Type"], "application/json")
        self.assertEqual(json.loads(req["body"]), {
            "state": {"text": "A post about the weather."},
            "questions": {"q": {"type": "noul",
                                "criteria": {"true": {"text": "Is it about pasta?"}, "false": None}}},
        })

    def test_doubt_sends_the_claim_as_state_and_a_fixed_doubt_question(self):
        self.jev("doubt", "The Earth is flat.")
        [req] = self.server.requests
        q = json.loads(req["body"])
        self.assertEqual(q["state"], {"text": "The Earth is flat."})
        self.assertEqual(q["questions"]["q"]["criteria"]["true"]["text"],
                         "This claim is doubtful or likely false.")

    def test_text_comes_from_flag_or_stdin(self):
        for args, stdin, sent in [
            (["-t", "from flag"], "ignored stdin", "from flag"),
            ([], "from stdin\n", "from stdin\n"),
            (["-t", "-"], "dash means stdin", "dash means stdin"),
        ]:
            with self.subTest(args=args):
                self.server.requests = []
                self.assertEqual(self.jev("ask", "q?", *args, stdin=stdin).returncode, 0)
                self.assertEqual(json.loads(self.server.requests[0]["body"])["state"]["text"], sent)

    def test_verdict_and_exit_code(self):
        for cmd, p_yes, verdict, code in [
            ("ask", 0.9, "yes", 0),
            ("ask", 0.5, "yes", 0),
            ("ask", 0.1, "no", 1),
            ("doubt", 0.9, "doubted", 0),
            ("doubt", 0.1, "trusted", 1),
        ]:
            with self.subTest(cmd=cmd, p_yes=p_yes):
                self.server.reply = {"body": answer(p_yes, 1 - p_yes, 0.8)}
                res = self.jev(cmd, "q?", "-t", "text") if cmd == "ask" else self.jev(cmd, "claim")
                self.assertEqual(res.returncode, code, res.stderr)
                self.assertEqual(res.stdout.split()[0], verdict)
                self.assertIn("confidence=80.0%", res.stdout)

    def test_ask_json(self):
        self.server.reply = {"body": answer(0.25, 0.75, 0.6)}
        res = self.jev("ask", "q?", "--json", stdin="text")
        self.assertEqual(res.returncode, 1)
        out = json.loads(res.stdout)
        self.assertEqual(out["verdict"], "no")
        self.assertEqual(out["confidence"], 0.6)
        self.assertEqual(out["probabilities"], {"yes": 0.25, "no": 0.75})

    def test_doubt_json(self):
        res = self.jev("doubt", "claim", "--json")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(res.stdout)["verdict"], "doubted")

    def test_confidence_gate_answers_unsure_with_exit_2(self):
        self.server.reply = {"body": answer(0.9, 0.1, 0.5)}
        for args in (["ask", "q?", "-t", "text"], ["doubt", "claim"]):
            with self.subTest(cmd=args[0]):
                res = self.jev(*args, "--confidence", "0.6")
                self.assertEqual(res.returncode, 2)
                self.assertEqual(res.stdout.split()[0], "unsure")
                res = self.jev(*args, "--confidence", "0.6", "--json")
                self.assertEqual(res.returncode, 2)
                self.assertEqual(json.loads(res.stdout)["verdict"], "unsure")
                self.assertEqual(self.jev(*args, "--confidence", "0.5").returncode, 0)

    def test_bad_responses_are_no_answer(self):
        for name, reply in [
            ("http 500", {"status": 500, "body": b"internal error"}),
            ("http 401", {"status": 401, "body": {"error": "bad key"}}),
            ("not json", {"body": b"<html>gateway</html>"}),
            ("error object", {"body": {"error": "boom"}}),
            ("no confidence", {"body": {"answers": {"q": {"probabilities": {"yes": 0.9, "no": 0.1}}}}}),
            ("non-numeric", {"body": answer("high", "low", 0.8)}),
            ("answers is a list", {"body": {"answers": []}}),
            ("probability above 1", {"body": answer(1.5, -0.5, 0.8)}),
            ("truncated body", {"body": b'{"answers": {', "length": 100}),
        ]:
            with self.subTest(name):
                self.server.reply = reply
                self.assertNoAnswer(self.jev("ask", "q?", "-t", "text", "--json"))

    def test_redirect_is_not_followed(self):
        # following it would send the Bearer key to the redirect target
        self.server.reply = {"status": 302, "location": "/elsewhere", "body": b""}
        self.assertNoAnswer(self.jev("ask", "q?", "-t", "text"))
        self.assertEqual([r["path"] for r in self.server.requests], ["/v1/systemone"])

    def test_slow_api_times_out_as_no_answer(self):
        self.server.reply = {"body": answer(0.9, 0.1, 0.8), "delay": 2}
        self.assertNoAnswer(self.jev("ask", "q?", "-t", "text", timeout=0.5))

    def test_unreachable_api_is_no_answer(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        (self.mimir / "base-url").write_text(f"http://127.0.0.1:{port}/v1")
        self.assertNoAnswer(self.jev("doubt", "claim"))

    def test_missing_credentials_are_no_answer(self):
        for name in ("api-key", "base-url"):
            with self.subTest(name):
                self.setUp()
                (self.mimir / name).unlink()
                self.assertNoAnswer(self.jev("ask", "q?", "-t", "text"))
                self.assertEqual(self.server.requests, [])

    def test_usage_errors_are_no_answer(self):
        for args in ([], ["ask"], ["doubt"], ["frobnicate", "x"], ["ask", "q?", "-t", " \n"],
                     ["doubt", ""], ["ask", "q?", "--confidence", "high", "-t", "text"]):
            with self.subTest(args=args):
                res = self.jev(*args)
                self.assertEqual(res.returncode, 2)
                self.assertEqual(res.stdout, "")
        self.assertEqual(self.server.requests, [])


@unittest.skipUnless(os.environ.get("JEV_LIVE") == "1", "set JEV_LIVE=1 to call the real SystemOne")
class JevLive(unittest.TestCase):
    def jev(self, *args):
        return subprocess.run([sys.executable, str(JEV), *args, "--json"],
                              capture_output=True, text=True, timeout=60)

    def test_ask(self):
        res = self.jev("ask", "The sky is blue.", "-t", "A clear summer day at noon.")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["verdict"], "yes")

    def test_doubt(self):
        res = self.jev("doubt", "The Earth is flat.")
        self.assertEqual(res.returncode, 0, res.stderr)


if __name__ == "__main__":
    unittest.main()
