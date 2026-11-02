/**
 * LIKE / ILIKE に渡すユーザー入力のメタ文字 (`%` `_` `\`) をエスケープする (#170)。
 *
 * 値はパラメータバインド済みなので SQL インジェクションではないが、エスケープしないと
 * 「%」の一語で全件に当たるなど、検索が意図せず広く当たる。
 *
 * SQL 側は **`ESCAPE '\\'` と書く** (JS のテンプレートリテラル内)。postgres.js はタグ付き
 * テンプレートの cooked 文字列を使うので、`ESCAPE '\'` と書くと `\'` が `'` になり
 * `ESCAPE ''` (エスケープ無効) として送られてしまう。
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 部分一致用のパターン `%<エスケープ済み>%` を作る。SQL 側には `ESCAPE '\\'` を付ける。 */
export function likeContains(s: string): string {
  return `%${escapeLike(s)}%`;
}
