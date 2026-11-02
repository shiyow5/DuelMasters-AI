"""freshness のログを、公開 Issue / Step Summary に貼れる形に伏せ字にする (stdin -> stdout)。

- 環境変数 DATABASE_URL があれば、そのホスト・ユーザー・パスワード・ポート付きホスト・
  netloc をそのまま *** に置き換える (値そのものは出力しない)。
- それとは別に、接続文字列・IPv4・括弧内の IPv6・Supabase のホスト名と
  `postgres.<project ref>` 形式のユーザー名を *** にする (DATABASE_URL と形が違っても漏らさない)。
- ::error:: / ::warning:: のワークフローコマンドは Issue 本文で読みにくいので `error: ` 等にする。
"""
from __future__ import annotations

import os
import re
import sys
from urllib.parse import unquote, urlsplit


def secret_parts(url: str) -> list[str]:
    """DATABASE_URL から伏せる値を長い順に返す (短すぎる値は誤置換を避けて除く)。"""
    if not url:
        return []
    try:
        u = urlsplit(url)
        host, user, password, port = u.hostname, u.username, u.password, u.port
    except ValueError:
        return [url]
    vals = {url, u.netloc, host, user, password}
    if user:
        vals.add(unquote(user))
    if password:
        vals.add(unquote(password))
    if host and port:
        vals.add(f"{host}:{port}")
    return sorted((v for v in vals if v and len(v) >= 3), key=len, reverse=True)


PATTERNS = [
    (re.compile(r"postgres(?:ql)?://\S+", re.IGNORECASE), "***"),
    (re.compile(r"\b[\w.-]+\.(?:supabase\.co|supabase\.com|pooler\.supabase\.com)\b", re.IGNORECASE), "***"),
    (re.compile(r"\bpostgres\.[a-z0-9]{6,}\b", re.IGNORECASE), "***"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"), "***"),
    (re.compile(r"\((?=[0-9a-fA-F:]*:)[0-9a-fA-F:.]+\)"), "(***)"),
    (re.compile(r"^::(error|warning)::", re.MULTILINE), r"\1: "),
]


def redact(text: str, url: str) -> str:
    for v in secret_parts(url):
        text = text.replace(v, "***")
    for pat, rep in PATTERNS:
        text = pat.sub(rep, text)
    return text


if __name__ == "__main__":
    sys.stdout.write(redact(sys.stdin.read(), os.environ.get("DATABASE_URL", "")))
