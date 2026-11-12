/**
 * 回答中の外部リンクを許可ホストだけに絞る (#254 M-3 ③ / L-5 #259)。
 *
 * 回答は LLM 由来で、RAG・ツール結果に仕込まれた文章に引きずられて「このURLを案内する」文を
 * 出すことがある (プロンプトでは確率的にしか防げない)。描画側で、**許可ホスト以外の http(s) リンクは
 * リンクにしない** (`テキスト (URL)` の非リンク表示)。クリックで外部へ誘導する経路を塞ぐ本命の対策。
 *
 * 許可ホストはここの 1 か所だけ。完全一致 (サブドメインは許可しない)。追加するときは理由をコメントに書く。
 * 出典リスト (citations) の「出典を開く」は別経路で、従来どおり `safeUrl` (scheme の許可制) で通す。
 */
export const ALLOWED_LINK_HOSTS: readonly string[] = [
  // 公式サイト。総合ルール・裁定 Q&A・カード情報の一次情報 (RAG の出典 URL はここ)
  "dm.takaratomy.co.jp",
  // 大会結果・週次ランキングの取込元 (tournament_results / archetype_weekly_stats の source_url は 100% ここ)
  "supersolenoid.jp",
  // デッキレシピの取込元 (deck_recipes の source)
  "deneblog.jp",
];

/**
 * http(s) リンクを href として出してよいか。
 *
 * - http(s) 以外 (相対リンク・`#脚注`・mailto/tel) はここでは判定しない (true)。scheme は `safeUrl` が見る。
 * - URL として解釈できない http(s) は false。
 * - ユーザー情報付き (`https://dm.takaratomy.co.jp@evil/`) は URL パーサが host を evil にするので落ちる。
 *   念のため username/password を持つものも false にする。
 */
export function isAllowedLink(href: string | undefined | null): boolean {
  if (!href) return false;
  const probe = href.replace(/[\u0000- \u007f]/g, "");
  if (!/^https?:/i.test(probe)) return true;
  let u: URL;
  try {
    u = new URL(probe);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  return ALLOWED_LINK_HOSTS.includes(u.hostname.toLowerCase());
}
