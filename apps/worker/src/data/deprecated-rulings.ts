/**
 * 現行ルールと矛盾することが**総合ルールの条文で裏取りできた**裁定の一覧 (#92)。
 *
 * 公式サイトの裁定 Q&A (qa_old) には改定前の回答がそのまま残っている。RAG がこれを引くと
 * agent の回答が汚れる (eval の rule-turn-flow で実害が出た)。
 *
 * ## この一覧が「レビュー済みの正」である理由
 *
 * 検出は `jobs/audit-rulings.ts` が LLM で行うが、**LLM の判定だけでは載せない**。
 * judge は過去にカードの実在性も DM のルールも誤った。載せる条件は、
 *
 *   1. LLM が「どの条番号のどの文言と矛盾するか」を逐語引用で示し、
 *   2. その条番号が実在し、引用が本当にその条文の部分列であることを機械検証で通り (verifyGrounding)、
 *   3. **人が条文を読んで確認した** —— この3つ。
 *
 * つまりここに載っているものは、`quote` を総合ルールで grep すれば誰でも追試できる。
 *
 * ## 消すのではなく印を付ける
 *
 * `deprecate-rulings.ts` がこの一覧を `chunk_meta.deprecated` に反映し、RAG 検索が除外する。
 * DB の行は消さないので、**この配列から1行消して流し直せば元に戻る**。
 * 週次の裁定取込 (cron) は裁定を DELETE+INSERT で入れ直すが、取込の最後にこの一覧を
 * 再適用するので印は復活する。
 */
export interface DeprecatedRuling {
  /** 公式サイトの qa_old の投稿 ID。 */
  qaId: number;
  /** 何の裁定か人が見て分かるように残す (照合用ではない)。 */
  question: string;
  /** 矛盾する総合ルールの条番号。 */
  article: string;
  /** その条文からの逐語引用。総合ルールを grep すれば追試できる。 */
  quote: string;
  /** なぜ矛盾なのか。 */
  reason: string;
}

export const DEPRECATED_RULINGS: DeprecatedRuling[] = [];
