# 運用手順: QUOTA_FAIL_OPEN の検知 (#260)

日次クォータ (`apps/api/src/middleware/daily-quota.ts`) は、カウンタ用 DB が失敗したときに
**リクエストを通す (fail-open)**。そのとき API は次のログを出す。DB 障害の兆候として運用で拾う。

```
[api] QUOTA_FAIL_OPEN 日次クォータのカウント失敗 (通過させる): {"event":"db_error","kind":"...","sqlstate":"...","errorId":"..."}
```

- DB 系の例外 (SQLSTATE あり) は `event: "db_error"` と `kind` / `sqlstate` / `errorId` を出す。
  それ以外の例外は `{"event":"error","name":"...","errorId":"..."}` となる。DB 障害の検知では前者を主に見る。
- いずれも例外 message・userId・DB 制約名は含まれない。
- fail-open 箇所は `daily-quota.ts` の `catch` の1か所のみ。
- `apps/api/wrangler.jsonc` は `observability.enabled: true` のため、Workers Logs に出力される。

## 1. Workers Logs での検索手順

1. Cloudflare ダッシュボード → Workers & Pages → `dm-ai-api` → **Logs** (Observability)。
2. 期間を指定する (直近 10分 / 1時間 / 24時間)。
3. 検索欄に `QUOTA_FAIL_OPEN` を入力する (文字列検索)。必要なら Level = `error` で絞る。
4. ヒット件数を確認する。同じ `errorId` / `sqlstate` が続くなら同一原因、複数種類なら複数の障害を疑う。`db_error` で絞ると DB 系に限定できる。

※ 画面の項目名は Cloudflare 側の更新で変わりうる。見つからない場合は Logs 画面の検索機能を使う。
参考: `wrangler tail dm-ai-api --search QUOTA_FAIL_OPEN` でもリアルタイムに確認できる
(認証済みの運用者のみ。秘密情報は出力しない)。

## 2. 閾値の目安

| 状況                | 目安                             | 対応                                                    |
| ------------------- | -------------------------------- | ------------------------------------------------------- |
| 単発 (10分に1〜4件) | 一時的な接続失敗の可能性         | 記録のみ。次回確認で再発を見る                          |
| **10分に5件以上**   | **DB 障害を疑う**                | DB (Supabase / Hyperdrive) の状態を確認し、チームに共有 |
| 30分以上継続        | 障害継続。クォータが効いていない | 上記に加え、Gemini 利用量の急増を確認し、PM に報告      |

数値は目安で、実際のトラフィックを見て調整する。

## 3. 見つけたときの確認と対応

1. 同時刻の `/api/chat` の 5xx、DB (Supabase) のステータスを確認する。
2. fail-open 中も分単位のレート制限は有効。Gemini 利用量が急増していないか確認する。
3. DB が復旧すれば自動で通常のクォータ判定に戻る (対応不要)。
4. 設定変更・再起動・DB 操作が必要な場合は PM 経由で承認を取る。

## 4. アラート化の状況

- **Cloudflare 通知 (自動アラート): 未設定・承認待ち。** 現状は上記の手動確認のみ。
- ログ形式の構造化 (`event` フィールド化) は未実施。必要になれば別 PR で検討する。
