/**
 * Discord bot — Cloudflare Workers 上の HTTP Interactions エンドポイント (Phase 1 PoC)。
 *
 * 目的: Ed25519 署名検証 + PING応答 + defer(type5)→follow-up webhook を実装し、
 * Workers→Discord の follow-up fetch 信頼性 (discord-api-docs#7936) を本番検証する。
 * コールドスタートは V8 isolate で <5ms のため Discord の 3秒 ACK には余裕がある。
 *
 * 実コマンド配線 (/dm rule|deck|meta|chat|format) は Phase 2 (api の Workers 化後) に追加する。
 * ここでは疎通検証用の `/dm ping` のみを実装する。
 */
import { verifyKey } from "discord-interactions";

export interface Env {
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

interface InteractionOption {
  name: string;
  type: number;
  value?: unknown;
  options?: InteractionOption[];
}

interface DiscordInteraction {
  type: number;
  id: string;
  token: string;
  data?: { name: string; options?: InteractionOption[] };
}

/** waitUntil だけ使うので ExecutionContext を最小定義 (workers-types を入れず型衝突を避ける) */
type Ctx = { waitUntil(promise: Promise<unknown>): void };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 1. Ed25519 署名検証 — Discord からの正当なリクエストのみ受理
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
      const sub = interaction.data?.options?.[0]?.name;
      if (sub === "ping") {
        // 3秒以内に defer を即返し、重い処理と follow-up は waitUntil で継続 (#7936 検証)
        ctx.waitUntil(sendPingFollowUp(interaction, env));
        return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
      }
      // Phase 2 で実装予定のコマンド
      return json({
        type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "このコマンドはまだ Workers 上で未対応です (Phase 2 で配線予定)。" },
      });
    }

    return new Response("Unknown interaction type", { status: 400 });
  },
};

/**
 * #7936 検証用: deferred レスポンスの後に follow-up webhook で元メッセージを編集する。
 * この PATCH が Workers から確実に解決するか (hang しないか) が Phase 1 の検証対象。
 */
async function sendPingFollowUp(interaction: DiscordInteraction, env: Env): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "🏓 pong — follow-up webhook OK (#7936 検証)" }),
  });
  if (!res.ok) {
    console.error(`follow-up webhook failed: ${res.status} ${await res.text()}`);
  }
}
