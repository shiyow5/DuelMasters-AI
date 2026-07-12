import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("dm")
    .setDescription("DM-AI コマンド")
    .addSubcommandGroup((group) =>
      group
        .setName("format")
        .setDescription("フォーマット設定")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("フォーマットを設定")
            .addStringOption((opt) =>
              opt
                .setName("type")
                .setDescription("フォーマット")
                .setRequired(true)
                .addChoices(
                  { name: "オリジナル", value: "original" },
                  { name: "アドバンス", value: "advance" },
                ),
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("rule")
        .setDescription("ルール質問")
        .addStringOption((opt) =>
          opt.setName("question").setDescription("質問内容").setRequired(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("deck")
        .setDescription("デッキ関連")
        .addSubcommand((sub) =>
          sub
            .setName("rate")
            .setDescription("デッキ評価")
            .addStringOption((opt) =>
              opt.setName("list").setDescription("デッキリスト").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("build")
            .setDescription("デッキ自動構築")
            .addStringOption((opt) =>
              opt.setName("theme").setDescription("テーマ").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("check")
            .setDescription("殿堂チェック")
            .addStringOption((opt) =>
              opt.setName("list").setDescription("デッキリスト").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("save")
            .setDescription("デッキを保存 (要ログイン設定)")
            .addStringOption((opt) =>
              opt.setName("list").setDescription("デッキリスト").setRequired(true),
            )
            .addStringOption((opt) =>
              opt.setName("name").setDescription("デッキ名").setRequired(true).setMaxLength(100),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("meta")
        .setDescription("環境分析")
        .addSubcommand((sub) =>
          sub
            .setName("tier")
            .setDescription("ティア表")
            .addStringOption((opt) => opt.setName("period").setDescription("期間 (例: 2w, 4w)")),
        )
        .addSubcommand((sub) =>
          sub
            .setName("deck")
            .setDescription("アーキタイプ詳細")
            .addStringOption((opt) =>
              opt.setName("name").setDescription("アーキタイプ名").setRequired(true),
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("chat")
        .setDescription("統合チャット")
        .addStringOption((opt) =>
          opt.setName("message").setDescription("メッセージ").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("ping").setDescription("Workers 疎通確認 (defer→follow-up の動作検証)"),
    ),
].map((cmd) => cmd.toJSON());

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    console.error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required");
    process.exit(1);
  }

  const rest = new REST().setToken(token);

  console.log("Deploying commands...");

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log(`Guild commands deployed to ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });
    console.log("Global commands deployed");
  }
}

main().catch(console.error);
