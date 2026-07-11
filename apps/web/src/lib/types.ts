/** API レスポンスの型 (apps/api の応答形状の写し。API 側を変えたらここも追随する) */

export interface Citation {
  text: string;
  section?: string;
  article?: string;
  url?: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  timestamp?: string;
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
