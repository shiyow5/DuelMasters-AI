/** API レスポンスの型 (apps/api の応答形状の写し。API 側を変えたらここも追随する) */

/**
 * 引用 (エージェントがツールから得た根拠)。
 * 実体は `{ text, ...chunk_meta }` なので doc_type / article 以外の任意キーも入りうる。
 */
export interface Citation {
  text: string;
  doc_type?: string;
  section?: string;
  article?: string;
  name?: string;
  url?: string;
  [key: string]: unknown;
}

export interface Message {
  /**
   * DB 上の発言 ID (#110)。保存された発言にだけ付く。
   * これが無いと「役に立った」を送れない (どの発言への評価か指定できない)。
   */
  id?: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  timestamp?: string;
  /** ストリーミング中 (content は途中経過。確定したら done の response で置き換わる) */
  streaming?: boolean;
  /**
   * いま何をしているか (進行表示。#98)。
   *
   * ツール名だけでなく引数まで含んだ完成済みの文言を入れる
   * (例:「ルールを検索しています: 「S・トリガー」」)。生成は `lib/tools.ts` が行う。
   */
  status?: string;
  /** エラーで終わった応答 (UI で赤く出す) */
  error?: boolean;
  /** 「役に立った / 立たなかった」(#110)。未評価は undefined。 */
  helpful?: boolean;
  /**
   * 失敗したツール名 (#109)。
   *
   * 空でないなら、**この回答は根拠が欠けている**。握り潰すと利用者には普通の回答に見え、
   * モデルが記憶で埋めた内容を信じてしまう (#112 で実際に起きた)。必ず画面に出す。
   */
  toolFailures?: string[];
}

export interface DeckScore {
  triggerCount: number;
  rainbowCount: number;
  costCurve: { low: number; mid: number; high: number };
  civilizationBalance: Record<string, number>;
  openingHandRate: number;
  roleBalance: Record<string, number>;
  overall: number;
  warnings: string[];
  suggestions: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface TierEntry {
  tier: string;
  archetype: string;
  usage_rate: number;
  win_rate: number | null;
}

export interface TierData {
  format: string;
  period: string;
  period_start: string;
  period_end: string;
  tier_data: TierEntry[];
}

export interface SavedDeckSummary {
  id: number;
  title: string;
  format: string;
  overall: number | null;
  created_at: string;
}
