"""GitHub Secret DATABASE_URL が開発既定値と同じか・含むかを true/false/unknown だけで出す。

- 環境変数 DATABASE_URL を文字列として解析・比較するだけ。DB には接続しない。
- 出力は 7 項目の真偽値と固定文言だけ。値・長さ・ハッシュ・部分文字列・例外の中身は出さない。
- 解析できないときは固定文言と unknown だけ出す (例外・traceback は出さない)。
- 判定結果では失敗させない。失敗 (exit 1) するのは Secret が空・未設定のときだけ。
"""

from __future__ import annotations

import os
from urllib.parse import unquote, urlsplit

# 比較用の既定値 (docker-compose.yml / README)。ログには出さない。
DEFAULT_PASSWORD = "postgres"
DEFAULT_USER = "postgres"
DEFAULT_DB = "dm_ai"
DEFAULT_URL = "postgresql://postgres:postgres@localhost:5432/dm_ai"
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "db")

LABELS = (
    "pass_eq_default",
    "pass_contains_default",
    "user_eq_default",
    "db_eq_default",
    "host_is_local",
    "url_eq_default",
    "pass_empty",
)


def _fmt(value: bool | None) -> str:
    if value is None:
        return "unknown"
    return "true" if value else "false"


def evaluate(url: str) -> tuple[dict[str, bool | None], bool]:
    """URL 文字列を判定する。(7項目の結果, 解析できたか) を返す。例外は投げない。"""
    result: dict[str, bool | None] = {label: None for label in LABELS}
    try:
        result["url_eq_default"] = url.strip() == DEFAULT_URL
        parts = urlsplit(url.strip())
        if parts.scheme not in ("postgres", "postgresql"):
            return result, False
        _ = parts.port  # 不正ポートはここで ValueError
        host = parts.hostname
        password = parts.password
        user = parts.username
        pw = unquote(password) if password else ""
        result["pass_empty"] = not password
        result["pass_eq_default"] = pw == DEFAULT_PASSWORD
        low = pw.lower()
        result["pass_contains_default"] = DEFAULT_PASSWORD in low or DEFAULT_DB in low
        result["user_eq_default"] = unquote(user) == DEFAULT_USER if user is not None else False
        result["db_eq_default"] = unquote(parts.path.lstrip("/")) == DEFAULT_DB
        result["host_is_local"] = (host or "").lower() in LOCAL_HOSTS
        return result, True
    except Exception:  # noqa: BLE001 - 中身は出さない
        return result, False


def render(result: dict[str, bool | None], parsed: bool) -> list[str]:
    lines = [f"{label}: {_fmt(result[label])}" for label in LABELS]
    if not parsed:
        lines.append("解析できない項目があり、判定できないものは unknown")
    return lines


def main() -> int:
    if not os.environ.get("DATABASE_URL", "").strip():
        # Secret が空・未設定のときだけ失敗させる。値は出さない。
        print("::error::Secret DATABASE_URL が無い")
        return 1
    try:
        result, parsed = evaluate(os.environ.get("DATABASE_URL", ""))
        lines = render(result, parsed)
    except Exception:  # noqa: BLE001
        lines = [f"{label}: unknown" for label in LABELS]
        lines.append("解析できない項目があり、判定できないものは unknown")
    out = "\n".join(lines)
    print(out)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        try:
            with open(summary, "a", encoding="utf-8") as f:
                f.write("### DATABASE_URL 既定値チェック\n\n```\n" + out + "\n```\n")
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
