import type { Citation } from "./state.js";

/**
 * 回答本文の条番号を、実際に retrieve した資料に照らして機械的に検証する (#99)。
 *
 * ## なぜプロンプトだけでは足りないのか
 *
 * システムプロンプトで「参考資料に出てこない条番号を書いてはいけません」と明示しても、
 * agent は **【総合ルール 114.6】【総合ルール 114.6a】** をでっち上げた
 * (総合ルールの 114章「カードを引くこと」は **114.1〜114.4 しか無い**)。
 * eval で実測して確認している。#92 の裁定監査でも同じことが起きた (701.29a / 116.3a を捏造)。
 *
 * **LLM に「捏造するな」と言っても捏造する。機械的に潰すしかない。**
 *
 * ## なぜ「番号だけ」落とすのか
 *
 * 主張そのものは正しいことがある (上の例も「山札切れで敗北する」自体は正しい。
 * 正しい条文は 703.4b)。文ごと消すと回答が意味不明になるので、**番号だけ**落として
 * 【総合ルール】に留める。利用者が 114.6 を調べに行って存在しない、というのが最悪の結果。
 */

/** `【総合ルール 113.6】` の条番号部分。枝番 (501.2a) も拾う。 */
const CITED_ARTICLE = /【総合ルール\s*(\d+(?:\.\d+[a-z]?)?)\s*】/g;

export interface SanitizeResult {
  /** 裏取りできない条番号を落とした本文。 */
  text: string;
  /** 落とした条番号 (重複は畳む)。捏造の発生を計測・監視するために返す。 */
  stripped: string[];
}

export function sanitizeCitations(text: string, citations: Citation[]): SanitizeResult {
  const retrieved = new Set(
    citations
      .map((c) => (c.article === undefined || c.article === null ? "" : String(c.article)))
      .filter(Boolean),
  );

  // 枝番 (104.2a) は親チャンク (104.2) の本文に埋まっており、citations には親の条番号しか
  // 載らない。枝番を捏造扱いすると**正しい引用まで落ちる** (#92 で実際にこの誤判定をやった)。
  const isGrounded = (article: string) =>
    retrieved.has(article) || retrieved.has(article.replace(/[a-z]$/, ""));

  const stripped = new Set<string>();
  const sanitized = text.replace(CITED_ARTICLE, (whole, article: string) => {
    if (isGrounded(article)) return whole;
    stripped.add(article);
    return "【総合ルール】";
  });

  return { text: sanitized, stripped: [...stripped] };
}
