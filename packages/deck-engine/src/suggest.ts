export interface SuggestInput {
  /** デッキ内カード (DB で解決済み。未解決カードは tags=[] で渡す) */
  deckCards: Array<{ name: string; count: number; cost: number; tags: string[] }>;
  /** goal ごとの候補カード (DB 検索済み・デッキ外・goal タグ持ち・コスト昇順) */
  candidatesByGoal: Map<
    string,
    Array<{ name: string; cost: number; tags: string[] }>
  >;
}

/**
 * 入替提案の選定 (決定的):
 * 1. 抜く候補 = デッキ内で「どの goal のタグも持たない」カードを count 多い順 → cost 高い順 → 名前昇順
 * 2. goal を入力順に処理し、各 goal の候補先頭から最大2枚を抜く候補と 1:1 で対応付ける
 * 3. 抜く候補が尽きたら打ち切る (original に "" を入れない)
 */
export function pickReplacements(input: SuggestInput): Array<{
  original: string;
  replacement: string;
  reason: string;
}> {
  const goals = [...input.candidatesByGoal.keys()];
  const goalSet = new Set(goals);

  const removable = input.deckCards
    .filter((c) => !c.tags.some((t) => goalSet.has(t)))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.cost !== a.cost) return b.cost - a.cost;
      return a.name.localeCompare(b.name);
    });

  const deckNames = new Set(input.deckCards.map((c) => c.name));
  const suggestions: Array<{
    original: string;
    replacement: string;
    reason: string;
  }> = [];
  let removeIdx = 0;

  for (const goal of goals) {
    const candidates = (input.candidatesByGoal.get(goal) ?? [])
      .filter((c) => !deckNames.has(c.name))
      .slice(0, 2);
    for (const cand of candidates) {
      if (removeIdx >= removable.length) return suggestions;
      const original = removable[removeIdx].name;
      removeIdx++;
      suggestions.push({
        original,
        replacement: cand.name,
        reason: `「${goal}」強化: ${cand.name} は ${goal} タグ持ち。${original} は目標に寄与しないため入替候補`,
      });
    }
  }

  return suggestions;
}
