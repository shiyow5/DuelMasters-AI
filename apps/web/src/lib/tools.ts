/**
 * エージェントのツール名 → 進行表示の文言。
 *
 * ツールを何本も回すと十数秒かかる。生のツール名 (`search_rules`) をそのまま出しても
 * 何が起きているか分からないので、日本語の進行状況にする。
 * 対応表に無いツールは名前をそのまま出す (新しいツールを足したときに黙って壊れないように)。
 */
export const TOOL_LABELS: Record<string, string> = {
  search_rules: "ルールを検索しています",
  search_cards: "カードを検索しています",
  evaluate_deck: "デッキを評価しています",
  build_deck: "デッキを構築しています",
  get_tier_list: "環境データを確認しています",
  suggest_improvements: "改善案を考えています",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
