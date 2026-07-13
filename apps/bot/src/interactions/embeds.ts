/**
 * Discord embed を素の JSON で組み立てる (純粋関数)。
 *
 * Workers 版では discord.js の EmbedBuilder を使わない (Worker を軽量に保つため)。
 * 配色と項目は gateway 版 (commands/index.ts) と揃える。
 */
import type { DeckScore, ValidationResult } from "@dm-ai/core";

/** Embed の配色 (Tailwind 由来のブランドカラー) */
export const EMBED_COLORS = {
  info: 0x3182ce, // ルール回答
  success: 0x38a169, // 高スコア / チェックOK
  warning: 0xecc94b, // 中スコア
  danger: 0xe53e3e, // 低スコア / チェックNG
  accent: 0x6366f1, // 構築・メタ表示
} as const;

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text: string };
}

export interface TierEntry {
  tier: string;
  archetype: string;
  usage_rate: number;
}

/** Discord の embed title の文字数上限。超えると PATCH が拒否され deferred のまま固まる。 */
const TITLE_MAX = 256;

/** Discord の文字数上限で切る。 */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

/** embed タイトル。theme / アーキタイプ名はユーザー入力なので必ず上限で切る。 */
function title(text: string): string {
  return truncate(text, TITLE_MAX);
}

export function formatLabel(format: string): string {
  return format === "original" ? "オリジナル" : "アドバンス";
}

export function ruleEmbed(response: string): Embed {
  return {
    title: "ルール回答",
    description: truncate(response, 4000),
    color: EMBED_COLORS.info,
    footer: { text: "DM-AI | ルール検索" },
  };
}

export function deckRateEmbed(score: DeckScore): Embed {
  const fields: EmbedField[] = [
    { name: "S・トリガー", value: `${score.triggerCount}枚`, inline: true },
    { name: "多色", value: `${score.rainbowCount}枚`, inline: true },
    { name: "初動率", value: `${Math.round(score.openingHandRate * 100)}%`, inline: true },
    {
      name: "コストカーブ",
      value: `低:${score.costCurve.low} 中:${score.costCurve.mid} 高:${score.costCurve.high}`,
    },
  ];
  if (score.warnings.length > 0) {
    fields.push({ name: "注意", value: truncate(score.warnings.join("\n"), 1024) });
  }
  return {
    title: `デッキ評価: ${score.overall}/100`,
    color:
      score.overall >= 70
        ? EMBED_COLORS.success
        : score.overall >= 40
          ? EMBED_COLORS.warning
          : EMBED_COLORS.danger,
    fields,
  };
}

export function deckBuildEmbed(
  theme: string,
  entries: Array<{ name: string; count: number }>,
): Embed {
  const deckText = entries.map((e) => `${e.count} ${e.name}`).join("\n");
  return {
    title: title(`自動構築: ${theme}`),
    description: `\`\`\`\n${truncate(deckText, 3900)}\n\`\`\``,
    color: EMBED_COLORS.accent,
  };
}

export function deckCheckEmbed(validation: ValidationResult): Embed {
  const fields: EmbedField[] = [];
  if (validation.errors.length > 0) {
    fields.push({ name: "エラー", value: truncate(validation.errors.join("\n"), 1024) });
  }
  if (validation.warnings.length > 0) {
    fields.push({ name: "警告", value: truncate(validation.warnings.join("\n"), 1024) });
  }
  return {
    title: validation.valid ? "殿堂チェック: OK" : "殿堂チェック: NG",
    color: validation.valid ? EMBED_COLORS.success : EMBED_COLORS.danger,
    ...(fields.length > 0 ? { fields } : {}),
  };
}

export function deckSaveEmbed(name: string, overall: number | undefined): Embed {
  return {
    title: "デッキ保存完了",
    description: `「${name}」を保存しました (スコア: ${overall ?? "-"}/100)`,
    color: EMBED_COLORS.success,
  };
}

export function tierEmbed(format: string, tierData: TierEntry[]): Embed {
  const fields: EmbedField[] = [];
  for (const tier of ["Tier1", "Tier2", "Tier3"]) {
    const entries = tierData.filter((e) => e.tier === tier);
    if (entries.length > 0) {
      fields.push({
        name: tier,
        value: truncate(
          entries.map((e) => `**${e.archetype}** (${e.usage_rate}%)`).join("\n"),
          1024,
        ),
      });
    }
  }
  return {
    title: `ティア表 (${formatLabel(format)})`,
    color: EMBED_COLORS.accent,
    ...(fields.length > 0 ? { fields } : {}),
  };
}

export function archetypeEmbed(
  archetype: string,
  stats: { total_entries: number; wins: number; top8: number } | null,
): Embed {
  return {
    title: title(archetype),
    color: EMBED_COLORS.accent,
    ...(stats
      ? {
          fields: [
            { name: "総エントリー", value: `${stats.total_entries}`, inline: true },
            { name: "優勝", value: `${stats.wins}`, inline: true },
            { name: "Top8", value: `${stats.top8}`, inline: true },
          ],
        }
      : {}),
  };
}
