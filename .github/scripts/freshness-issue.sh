#!/usr/bin/env bash
# freshness workflow が失敗したときに Issue を起票する。
# **同じタイトルの open Issue があれば、新しく起票せずコメントを足すだけ**にする (毎週の重複起票を防ぐ)。
#
# 必要な環境変数:
#   GH_TOKEN  — GITHUB_TOKEN (この job だけ issues: write)
#   GH_REPO   — owner/repo
#   RUN_URL   — 失敗した run の URL
#   REPORT    — 鮮度チェックの出力 (空でもよい)
#
# 出力: 標準出力の最後の行に `created` か `commented #<番号>` を出す (テストで使う)。
set -euo pipefail

TITLE="[freshness] 取込データが古くなっています"

: "${RUN_URL:?RUN_URL is required}"
REPORT="${REPORT:-}"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
{
  echo "鮮度チェック (freshness workflow) が失敗しました。"
  echo
  echo "- run: ${RUN_URL}"
  echo "- 判定日 (JST): $(TZ=Asia/Tokyo date +%Y-%m-%d)"
  echo
  if [ -n "$REPORT" ]; then
    echo '```'
    printf '%s\n' "$REPORT"
    echo '```'
  else
    echo "(チェックの出力を取れませんでした。DB 接続エラーの可能性があります。run のログを見てください)"
  fi
  echo
  echo "注: このチェックは workflow 自体の停止 (schedule の60日自動停止) は検知できません。"
} >"$body_file"

# 検索インデックス (--search) は反映が遅れることがあるので使わず、open の一覧からタイトル完全一致で探す。
existing="$(gh issue list --state open --limit 200 --json number,title \
  --jq ".[] | select(.title == \"${TITLE}\") | .number" | head -n 1)"

if [ -n "$existing" ]; then
  gh issue comment "$existing" --body-file "$body_file"
  echo "commented #${existing}"
else
  gh issue create --title "$TITLE" --body-file "$body_file"
  echo "created"
fi
