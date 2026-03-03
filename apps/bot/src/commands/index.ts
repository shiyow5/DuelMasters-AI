import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";

const API_URL = process.env.API_URL ?? "http://localhost:3001";

/** ユーザーごとのフォーマット設定 */
const userFormats = new Map<string, string>();

export async function handleCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
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

async function handleFormatSet(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const format = interaction.options.getString("type", true);
  userFormats.set(interaction.user.id, format);
  await interaction.reply(
    `フォーマットを **${format === "original" ? "オリジナル" : "アドバンス"}** に設定しました`
  );
}

async function handleRule(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const question = interaction.options.getString("question", true);
  await interaction.deferReply();

  const res = await apiPost("/api/chat", {
    message: question,
    mode: "rule",
  });

  const embed = new EmbedBuilder()
    .setTitle("ルール回答")
    .setDescription(truncate(res.response, 4000))
    .setColor(0x3182ce)
    .setFooter({ text: "DM-AI | ルール検索" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleDeck(
  interaction: ChatInputCommandInteraction,
  sub: string
): Promise<void> {
  const format = userFormats.get(interaction.user.id) ?? "original";

  if (sub === "rate") {
    const list = interaction.options.getString("list", true);
    await interaction.deferReply();

    const res = await apiPost("/api/deck/evaluate", {
      decklist: list,
      format,
    });

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
        }
      )
      .setColor(score.overall >= 70 ? 0x38a169 : score.overall >= 40 ? 0xecc94b : 0xe53e3e);

    if (score.warnings.length > 0) {
      embed.addFields({
        name: "注意",
        value: score.warnings.join("\n"),
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } else if (sub === "build") {
    const theme = interaction.options.getString("theme", true);
    await interaction.deferReply();

    const res = await apiPost("/api/deck/build", { theme, format });
    const deckText = res.entries
      .map((e: { count: number; name: string }) => `${e.count} ${e.name}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`自動構築: ${theme}`)
      .setDescription(`\`\`\`\n${truncate(deckText, 3900)}\n\`\`\``)
      .setColor(0x6366f1);

    await interaction.editReply({ embeds: [embed] });
  } else if (sub === "check") {
    const list = interaction.options.getString("list", true);
    await interaction.deferReply();

    const res = await apiPost("/api/deck/evaluate", {
      decklist: list,
      format,
    });

    const v = res.validation;
    const embed = new EmbedBuilder()
      .setTitle(v.valid ? "殿堂チェック: OK" : "殿堂チェック: NG")
      .setColor(v.valid ? 0x38a169 : 0xe53e3e);

    if (v.errors.length > 0) {
      embed.addFields({ name: "エラー", value: v.errors.join("\n") });
    }
    if (v.warnings.length > 0) {
      embed.addFields({ name: "警告", value: v.warnings.join("\n") });
    }

    await interaction.editReply({ embeds: [embed] });
  }
}

async function handleMeta(
  interaction: ChatInputCommandInteraction,
  sub: string
): Promise<void> {
  const format = userFormats.get(interaction.user.id) ?? "original";

  if (sub === "tier") {
    const period = interaction.options.getString("period") ?? "4w";
    await interaction.deferReply();

    const res = await apiGet(
      `/api/meta/tier?format=${format}&period=${period}`
    );

    if (!res.tier_data || res.tier_data.length === 0) {
      await interaction.editReply("ティアデータがまだありません");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`ティア表 (${format === "original" ? "オリジナル" : "アドバンス"})`)
      .setColor(0x6366f1);

    for (const tier of ["Tier1", "Tier2", "Tier3"]) {
      const entries = res.tier_data.filter(
        (e: { tier: string }) => e.tier === tier
      );
      if (entries.length > 0) {
        embed.addFields({
          name: tier,
          value: entries
            .map(
              (e: { archetype: string; usage_rate: number }) =>
                `**${e.archetype}** (${e.usage_rate}%)`
            )
            .join("\n"),
        });
      }
    }

    await interaction.editReply({ embeds: [embed] });
  } else if (sub === "deck") {
    const name = interaction.options.getString("name", true);
    await interaction.deferReply();

    const res = await apiGet(
      `/api/meta/archetype/${encodeURIComponent(name)}?format=${format}`
    );

    const embed = new EmbedBuilder()
      .setTitle(res.archetype)
      .setColor(0x6366f1);

    if (res.stats) {
      embed.addFields(
        {
          name: "総エントリー",
          value: `${res.stats.total_entries}`,
          inline: true,
        },
        { name: "優勝", value: `${res.stats.wins}`, inline: true },
        { name: "Top8", value: `${res.stats.top8}`, inline: true }
      );
    }

    await interaction.editReply({ embeds: [embed] });
  }
}

async function handleChat(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const message = interaction.options.getString("message", true);
  await interaction.deferReply();

  const res = await apiPost("/api/chat", {
    message,
    mode: "integrated",
  });

  await interaction.editReply(truncate(res.response, 2000));
}

// --- helpers ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}
