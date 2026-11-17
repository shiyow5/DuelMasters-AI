import { Client, GatewayIntentBits, Events, type Interaction } from "discord.js";
import { getErrorName } from "@dm-ai/core";
import { handleCommand } from "./commands/index.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Bot ready: ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await handleCommand(interaction);
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN is not set");
  process.exit(1);
}

if (!process.env.INTERNAL_API_KEY) {
  console.warn(
    "INTERNAL_API_KEY が未設定です。フォーマット保存・デッキ保存コマンドは利用できません",
  );
}

client.login(token).catch((err) => {
  // err をそのまま出さない (#311)。discord.js の例外 message / stack にはトークン断片や
  // 接続情報が入りうるので、種別名と errorId だけを出す。
  console.error(
    "Discord へのログインに失敗しました:",
    JSON.stringify({ event: "error", name: getErrorName(err), errorId: crypto.randomUUID() }),
  );
  process.exit(1);
});
