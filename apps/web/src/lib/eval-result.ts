import { scoreGrade } from "./format";
import type { DeckScore, ValidationResult } from "./types";

/**
 * デッキ評価完了時の「結果へ移動」まわりの純粋関数 (UI改善 P-3)。
 * DOM に触らない部分だけをここに置き、vitest で確かめられるようにする。
 */

/**
 * 3 カラム表示 (結果が評価ボタンと同時に見える) になる境界。
 * Tailwind の `lg` (1024px) と **必ず一致させる** (ストリップの `lg:hidden` と同じ境界)。
 */
export const DESKTOP_MEDIA_QUERY = "(min-width: 1024px)";

/** OS の「視差効果を減らす」設定 */
export const REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 結果へスクロールするときの behavior。
 * reduce 指定時だけ瞬時 (`auto`)、それ以外は `smooth` (P-3-7 決定 2)。
 */
export function resultScrollBehavior(prefersReducedMotion: boolean): ScrollBehavior {
  return prefersReducedMotion ? "auto" : "smooth";
}

/** 殿堂チェックのエラー件数。チェック結果が無い / 通過なら 0 */
export function validationErrorCount(validation: ValidationResult | null): number {
  if (!validation || validation.valid) return 0;
  return validation.errors.length;
}

/**
 * スクリーンリーダー向けの完了アナウンス文 (デスクトップ幅用)。
 * デスクトップではフォーカスを動かさないので、代わりに role="status" でこれを読ませる。
 */
export function evalAnnouncement(score: DeckScore, validation: ValidationResult | null): string {
  const errors = validationErrorCount(validation);
  return (
    `評価完了。ランク${scoreGrade(score.overall)}、${score.overall}点` +
    (errors > 0 ? `、殿堂チェックのエラー${errors}件` : "")
  );
}
