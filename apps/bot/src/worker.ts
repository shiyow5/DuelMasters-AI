/**
 * Discord bot — Cloudflare Workers 上の HTTP Interactions エンドポイント。
 *
 * Ed25519 署名検証 → PING応答 → defer(type5) → follow-up webhook で本文を編集する。
 * コールドスタートは V8 isolate で <5ms のため Discord の 3秒 ACK には余裕がある。
 *
 * 重い処理 (api 呼び出し) は必ず defer した後に ctx.waitUntil で継続する。
 * コマンドの実装は interactions/ に分離してある (worker はトランスポートに徹する)。
 */
import { verifyKey } from "discord-interactions";
import { parseCommand, type InteractionOption } from "./interactions/parse.js";
import { runCommand, type BotEnv, type MessagePayload } from "./interactions/run.js";

export interface Env extends BotEnv {
  /** Discord アプリの Public Key (署名検証用、非機密) */
  DISCORD_PUBLIC_KEY: string;
  /** Discord アプリケーション(クライアント) ID (follow-up webhook URL 用、非機密) */
  DISCORD_APPLICATION_ID: string;
}

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

const MessageFlags = { EPHEMERAL: 64 } as const;

interface DiscordInteraction {
  type: number;
  id: string;
  token: string;
  data?: { name: string; options?: InteractionOption[] };
  /** ギルド内は member.user、DM は user に入る */
  member?: { user?: { id: string } };
  user?: { id: string };
}

/** waitUntil だけ使うので ExecutionContext を最小定義 (workers-types を入れず型衝突を避ける) */
type Ctx = { waitUntil(promise: Promise<unknown>): void };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 実行者の Discord ID。ギルドとDMで入る場所が違う。 */
function userId(interaction: DiscordInteraction): string {
  return interaction.member?.user?.id ?? interaction.user?.id ?? "unknown";
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 1. Ed25519 署名検証 (Discord 以外からのリクエストを拒否)
    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const rawBody = await request.text();
    const isValid =
      signature != null &&
      timestamp != null &&
      (await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY));
    if (!isValid) {
      return new Response("Bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(rawBody) as DiscordInteraction;

    // 2. PING → PONG (Interactions Endpoint URL 登録時の疎通検証)
    if (interaction.type === InteractionType.PING) {
      return json({ type: ResponseType.PONG });
    }

    // 3. スラッシュコマンド
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const parsed = parseCommand(interaction);
      if (!parsed) {
        return json({
          type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "コマンドを解釈できませんでした", flags: MessageFlags.EPHEMERAL },
        });
      }

      if (parsed.sub === "ping") {
        ctx.waitUntil(sendFollowUp(interaction, env, { content: "🏓 pong" }));
        return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
      }

      // 3秒以内に defer を返し、api 呼び出しと follow-up は waitUntil で継続する。
      ctx.waitUntil(
        runCommand(parsed, userId(interaction), env).then((msg) =>
          sendFollowUp(interaction, env, msg),
        ),
      );
      return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
    }

    return new Response("Unknown interaction type", { status: 400 });
  },
};

/**
 * deferred レスポンスの後に follow-up webhook で元メッセージを編集する。
 *
 * 重要: `User-Agent` ヘッダは必須級。無いと Workers→Discord の follow-up fetch が
 * hang して応答が「考え中…」のまま止まる (discord-api-docs#7936)。UA を付けると解消する
 * (本番検証で 5/5 status=200 を確認済み)。
 */
const DISCORD_UA = "DM-AI-Bot (https://github.com/shiyow5/DuelMasters-AI, 0.1)";

async function sendFollowUp(
  interaction: DiscordInteraction,
  env: Env,
  message: MessagePayload,
): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", "user-agent": DISCORD_UA },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      console.error(`follow-up failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(
      `follow-up threw: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
  }
}
