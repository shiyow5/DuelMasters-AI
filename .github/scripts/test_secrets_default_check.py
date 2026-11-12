"""secrets-default-check.py の unittest。偽 URL のみ使う。"""

from __future__ import annotations

import importlib.util
import io
import os
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

_PATH = Path(__file__).with_name("secrets-default-check.py")
_spec = importlib.util.spec_from_file_location("secrets_default_check", _PATH)
scd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scd)

SUPABASE = "postgresql://postgres.abcref:Str0ngPass@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres"


def ev(url: str) -> dict:
    return scd.evaluate(url)[0]


class EvaluateTest(unittest.TestCase):
    def test_default_url(self):
        r, ok = scd.evaluate(scd.DEFAULT_URL)
        self.assertTrue(ok)
        for k in scd.LABELS:
            self.assertIs(r[k], k != "pass_empty", k)

    def test_supabase_like(self):
        r, ok = scd.evaluate(SUPABASE)
        self.assertTrue(ok)
        self.assertTrue(all(v is False for v in r.values()), r)

    def test_no_password(self):
        r = ev("postgresql://u@example.com:5432/x")
        self.assertIs(r["pass_empty"], True)
        self.assertIs(r["pass_eq_default"], False)
        r = ev("postgresql://u:@example.com/x")
        self.assertIs(r["pass_empty"], True)

    def test_password_contains(self):
        r = ev("postgresql://u:Postgres123@example.com/x")
        self.assertIs(r["pass_contains_default"], True)
        self.assertIs(r["pass_eq_default"], False)
        self.assertIs(ev("postgresql://u:xDM_AIx@example.com/x")["pass_contains_default"], True)

    def test_percent_encoded_password(self):
        r = ev("postgresql://u:post%67res@example.com/x")
        self.assertIs(r["pass_eq_default"], True)

    def test_host_db(self):
        self.assertIs(ev("postgresql://u:p@db:5432/x")["host_is_local"], True)
        self.assertIs(ev("postgresql://u:p@[::1]:5432/x")["host_is_local"], True)
        self.assertIs(ev("postgresql://u:p@LOCALHOST/x")["host_is_local"], True)

    def test_invalid_port(self):
        r, ok = scd.evaluate("postgresql://u:p@h:abc/d")
        self.assertFalse(ok)
        self.assertIn(None, r.values())

    def test_broken_strings(self):
        for s in ("", "not a url", "http://u:p@h/d", "postgresql://[bad/x"):
            r, ok = scd.evaluate(s)
            self.assertFalse(ok, s)
            self.assertIn(None, r.values())


class OutputTest(unittest.TestCase):
    def run_main(self, url: str) -> str:
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"DATABASE_URL": url}, clear=False), redirect_stdout(buf):
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            self.assertEqual(scd.main(), 0)
        return buf.getvalue()

    def test_output_has_no_secret_values(self):
        out = self.run_main("postgresql://alice:Zq9secretPw@db-host.example.net:6543/mydb")
        for leak in ("Zq9secretPw", "db-host.example.net", "alice", "mydb", "6543"):
            self.assertNotIn(leak, out)
        for line in out.splitlines():
            self.assertRegex(line, r"^\w+: (true|false|unknown)$")

    def test_labels_have_no_default_words(self):
        out = self.run_main("postgresql://u:p@h:abc/d")
        for w in ("postgres", "dm_ai", "localhost"):
            self.assertNotIn(w, out)
        self.assertIn("unknown", out)
        self.assertIn("解析できない", out)


if __name__ == "__main__":
    unittest.main()
