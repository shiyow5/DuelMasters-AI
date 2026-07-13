import { type ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import type { DeckScore, ValidationResult } from "@dm-ai/core";

const API_URL = process.env.API_URL ?? "http://localhost:3001";

interface TierEntry {
  tier: string;
  archetype: string;
  usage_rate: number;
}

/** Embed の配色 (Tailwind 由来のブランドカラー) */
const EMBED_COLORS = {
  info: 0x3182ce, // ルール回答
  success: 0x38a169, // 高スコア / チェックOK
  warning: 0xecc94b, // 中スコア
  danger: 0xe53e3e, // 低スコア / チェックNG
  accent: 0x6366f1, // 構築・メタ表示
} as const;

/** ユーザーごとのフォーマット設定 (API のキャッシュ) */
const userFormats = new Map<string, string>();

/** 内部認証ヘッダ (INTERNAL_API_KEY 未設定なら空 = 認証系コマンドは失敗する) */
function internalHeaders(discordId: string): Record<string, string> {
  const key = process.env.INTERNAL_API_KEY;
  return key ? { "X-Internal-Key": key, "X-User-Id": `discord:${discordId}` } : {};
}

/** フォーマット解決: Map になければ API から取得してキャッシュ */
async function resolveFormat(discordId: string): Promise<string> {
  const cached = userFormats.get(discordId);
  if (cached) return cached;
  try {
    const res = await apiGet<{ format: string }>("/api/user/settings", internalHeaders(discordId));
    userFormats.set(discordId, res.format);
    return res.format;
  } catch {
    return "original";
  }
}

export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  try {
    if (group === "format" && sub === "set") {
      await handleFormatSet(interaction);
    } else if (sub === "rule") {
      await handleRule(interaction);
    } else if (group === "deck") {
      await handleDeck(interaction, sub);
    } else if (group === "meta") {
      await handleMeta(interaction, sub);
    } else if (sub === "chat") {
      await handleChat(interaction);
    } else {
      await interaction.reply("不明なコマンドです");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "不明なエラー";
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(`エラー: ${msg}`);
    } else {
      await interaction.reply({ content: `エラー: ${msg}`, ephemeral: true });
    }
  }
}

async function handleFormatSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const format = interaction.options.getString("type", true);
  const discordId = interaction.user.id;
  userFormats.set(discordId, format);
  const label = format === "original" ? "オリジナル" : "アドバンス";
  try {
    await apiPut("/api/user/settings", { format }, internalHeaders(discordId));
    await interaction.reply(`フォーマットを **${label}** に設定しました`);
  } catch {
    await interaction.reply(
      `フォーマットを **${label}** に設定しました(設定の保存に失敗しました。次回再起動まで有効)`,
    );
  }
}

async function handleRule(interaction: ChatInputCommandInteraction): Promise<void> {
  const question = interaction.options.getString("question", true);
  await interaction.deferReply();

  const res = await apiPost<{ response: string }>(
    "/api/chat",
    { message: question, mode: "rule" },
    internalHeaders(interaction.user.id),
  );

  const embed = new EmbedBuilder()
    .setTitle("ルール回答")
    .setDescription(truncate(res.response, 4000))
    .setColor(EMBED_COLORS.info)
    .setFooter({ text: "DM-AI | ルール検索" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleDeck(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  // API 呼び出し (resolveFormat 含む) の前に defer し、Discord の初期応答3秒枠切れを防ぐ
  await interaction.deferReply();
  const format = await resolveFormat(interaction.user.id);

  if (sub === "rate") {
    const list = interaction.options.getString("list", true);

    const res = await apiPost<{
      score: DeckScore;
      validation: ValidationResult;
    }>("/api/deck/evaluate", { decklist: list, format }, internalHeaders(interaction.user.id));

    const score = res.score;
    const embed = new EmbedBuilder()
      .setTitle(`デッキ評価: ${score.overall}/100`)
      .addFields(
        { name: "S・トリガー", value: `${score.triggerCount}枚`, inline: true },
        { name: "多色", value: `${score.rainbowCount}枚`, inline: true },
        {
          name: "初動率",
          value: `${Math.round(score.openingHandRate * 100)}%`,
          inline: true,
        },
        {
          name: "コストカーブ",
          value: `低:${score.costCurve.low} 中:${score.costCurve.mid} 高:${score.costCurve.high}`,
        },
      )
      .setColor(
        score.overall >= 70
          ? EMBED_COLORS.success
          : score.overall >= 40
            ? EMBED_COLORS.warning
            : EMBED_COLORS.danger,
      );

    if (score.warnings.length > 0) {
      embed.addFields({
        name: "注意",
        value: score.warnings.join("\n"),
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } else if (sub === "build") {
    const theme = interaction.options.getString("theme", true);

    const res = await apiPost<{
      entries: Array<{ name: string; count: number }>;
    }>("/api/deck/build", { theme, format }, internalHeaders(interaction.user.id));
    const deckText = res.entries.map((e) => `${e.count} ${e.name}`).join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`自動構築: ${theme}`)
      .setDescription(`\`\`\`\n${truncate(deckText, 3900)}\n\`\`\``)
      .setColor(EMBED_COLORS.accent);

    await interaction.editReply({ embeds: [embed] });
  } else if (sub === "check") {
    const list = interaction.options.getString("list", true);

    const res = await apiPost<{
      score: DeckScore;
      validation: ValidationResult;
    }>("/api/deck/evaluate", { decklist: list, format }, internalHeaders(interaction.user.id));

    const v = res.validation;
    const embed = new EmbedBuilder()
      .setTitle(v.valid ? "殿堂チェック: OK" : "殿堂チェック: NG")
      .setColor(v.valid ? EMBED_COLORS.success : EMBED_COLORS.danger);

    if (v.errors.length > 0) {
      embed.addFields({ name: "エラー", value: v.errors.join("\n") });
    }
    if (v.warnings.length > 0) {
      embed.addFields({ name: "警告", value: v.warnings.join("\n") });
    }

    await interaction.editReply({ embeds: [embed] });
  } else if (sub === "save") {
    const list = interaction.options.getString("list", true);
    const name = interaction.options.getString("name", true);
    try {
      const res = await apiPost<{ scores: { overall: number } | null }>(
        "/api/deck/save",
        { title: name, format, decklist: list },
        internalHeaders(interaction.user.id),
      );
      const embed = new EmbedBuilder()
        .setTitle("デッキ保存完了")
        .setDescription(`「${name}」を保存しました (スコア: ${res.scores?.overall ?? "-"}/100)`)
        .setColor(EMBED_COLORS.success);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply(
        `保存に失敗しました: ${err instanceof Error ? err.message : "不明"}`,
      );
    }
  }
}

async function handleMeta(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  // API 呼び出し (resolveFormat 含む) の前に defer し、Discord の初期応答3秒枠切れを防ぐ
  await interaction.deferReply();
  const format = await resolveFormat(interaction.user.id);

  if (sub === "tier") {
    const period = interaction.options.getString("period") ?? "4w";

    const res = await apiGet<{ tier_data: TierEntry[] }>(
      `/api/meta/tier?format=${format}&period=${period}`,
      internalHeaders(interaction.user.id),
    );

    if (!res.tier_data || res.tier_data.length === 0) {
      await interaction.editReply("ティアデータがまだありません");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`ティア表 (${format === "original" ? "オリジナル" : "アドバンス"})`)
      .setColor(EMBED_COLORS.accent)
      // CS の入賞数集計は田園補完計画から取り込んでいる。Workers 側 (interactions/embeds.ts)
      // と同じ出典を出す。
      .setFooter({ text: "大会結果の出典: 田園補完計画 (supersolenoid.jp)" });

    for (const tier of ["Tier1", "Tier2", "Tier3"]) {
      const entries = res.tier_data.filter((e) => e.tier === tier);
      if (entries.length > 0) {
        embed.addFields({
          name: tier,
          value: entries.map((e) => `**${e.archetype}** (${e.usage_rate}%)`).join("\n"),
        });
      }
    }

    await interaction.editReply({ embeds: [embed] });
  } else if (sub === "deck") {
    const name = interaction.options.getString("name", true);

    const res = await apiGet<{
      archetype: string;
      stats: { total_entries: number; wins: number; top8: number } | null;
    }>(
      `/api/meta/archetype/${encodeURIComponent(name)}?format=${format}`,
      internalHeaders(interaction.user.id),
    );

    const embed = new EmbedBuilder().setTitle(res.archetype).setColor(EMBED_COLORS.accent);

    if (res.stats) {
      embed.addFields(
        {
          name: "総エントリー",
          value: `${res.stats.total_entries}`,
          inline: true,
        },
        { name: "優勝", value: `${res.stats.wins}`, inline: true },
        { name: "Top8", value: `${res.stats.top8}`, inline: true },
      );
    }

    await interaction.editReply({ embeds: [embed] });
  }
}

async function handleChat(interaction: ChatInputCommandInteraction): Promise<void> {
  const message = interaction.options.getString("message", true);
  await interaction.deferReply();

  const res = await apiPost<{ response: string }>(
    "/api/chat",
    { message, mode: "integrated" },
    internalHeaders(interaction.user.id),
  );

  await interaction.editReply(truncate(res.response, 2000));
}

// --- helpers ---

// api は全エンドポイントがログイン必須。Discord ユーザーは Supabase ログインを持たないため、
// bot は内部キー + Discord ID で認証する (headers は internalHeaders(discordId) を渡す)。
async function apiPost<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPut<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}
