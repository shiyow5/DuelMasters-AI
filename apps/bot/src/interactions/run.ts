/**
 * スラッシュコマンドを api 経由で実行し、follow-up で返すメッセージを組み立てる。
 *
 * gateway 版 (commands/index.ts) との違い:
 * - discord.js を使わない (interaction.options → parseCommand、EmbedBuilder → 素の JSON)
 * - フォーマットはインメモリ Map ではなく毎回 api から引く。Worker はリクエストごとに使い捨て
 *   なので、Map に載せても次のリクエストでは消えている。DB が唯一の真実源。
 * - defer 済み前提。ここでは「編集して返す本文」だけを作る (送信は worker.ts の follow-up)。
 */
import type { DeckScore, ValidationResult } from "@dm-ai/core";
import type { ParsedCommand } from "./parse.js";
import {
  archetypeEmbed,
  deckBuildEmbed,
  deckCheckEmbed,
  deckRateEmbed,
  deckSaveEmbed,
  formatLabel,
  ruleEmbed,
  tierEmbed,
  truncate,
  type Embed,
  type TierEntry,
} from "./embeds.js";

export interface BotEnv {
  /** api Worker のベース URL */
  API_URL: string;
  /** 内部 API 認証キー (デッキ保存・ユーザー設定に必要)。未設定なら該当コマンドは失敗する。 */
  INTERNAL_API_KEY?: string;
}

/** Discord の follow-up (webhook PATCH) に渡す本文。 */
export interface MessagePayload {
  content?: string;
  embeds?: Embed[];
}

const DEFAULT_FORMAT = "original";

function internalHeaders(env: BotEnv, discordId: string): Record<string, string> {
  return env.INTERNAL_API_KEY
    ? { "X-Internal-Key": env.INTERNAL_API_KEY, "X-User-Id": `discord:${discordId}` }
    : {};
}

async function apiFetch<T>(
  env: BotEnv,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`${env.API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as T;
}

const apiGet = <T>(env: BotEnv, path: string, headers?: Record<string, string>) =>
  apiFetch<T>(env, path, { method: "GET", headers });

const apiSend = <T>(
  env: BotEnv,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) => apiFetch<T>(env, path, { method, body: JSON.stringify(body), headers });

/** ユーザーのフォーマット設定。取得に失敗したら既定 (オリジナル) に倒す。 */
async function resolveFormat(env: BotEnv, discordId: string): Promise<string> {
  try {
    const res = await apiGet<{ format: string }>(
      env,
      "/api/user/settings",
      internalHeaders(env, discordId),
    );
    return res.format ?? DEFAULT_FORMAT;
  } catch {
    return DEFAULT_FORMAT;
  }
}

/**
 * コマンドを実行して follow-up 本文を返す。
 * 例外はここで握って「エラー: ...」の本文にする (throw すると follow-up が送られず
 * 「考え中…」のまま固まるため)。
 */
export async function runCommand(
  parsed: ParsedCommand,
  discordId: string,
  env: BotEnv,
): Promise<MessagePayload> {
  try {
    return await dispatch(parsed, discordId, env);
  } catch (err) {
    return { content: `エラー: ${err instanceof Error ? err.message : "不明なエラー"}` };
  }
}

async function dispatch(
  parsed: ParsedCommand,
  discordId: string,
  env: BotEnv,
): Promise<MessagePayload> {
  const { group, sub, options } = parsed;

  if (group === "format" && sub === "set") {
    const format = options.type ?? DEFAULT_FORMAT;
    await apiSend(env, "PUT", "/api/user/settings", { format }, internalHeaders(env, discordId));
    return { content: `フォーマットを **${formatLabel(format)}** に設定しました` };
  }

  if (sub === "rule") {
    const res = await apiSend<{ response: string }>(env, "POST", "/api/chat", {
      message: options.question,
      mode: "rule",
    });
    return { embeds: [ruleEmbed(res.response)] };
  }

  if (sub === "chat") {
    const res = await apiSend<{ response: string }>(env, "POST", "/api/chat", {
      message: options.message,
      mode: "integrated",
    });
    return { content: truncate(res.response, 2000) };
  }

  if (group === "deck") return deckCommand(sub, options, discordId, env);
  if (group === "meta") return metaCommand(sub, options, discordId, env);

  return { content: "不明なコマンドです" };
}

async function deckCommand(
  sub: string,
  options: Record<string, string>,
  discordId: string,
  env: BotEnv,
): Promise<MessagePayload> {
  const format = await resolveFormat(env, discordId);

  if (sub === "build") {
    const theme = options.theme;
    const res = await apiSend<{ entries: Array<{ name: string; count: number }> }>(
      env,
      "POST",
      "/api/deck/build",
      { theme, format },
    );
    return { embeds: [deckBuildEmbed(theme, res.entries)] };
  }

  if (sub === "rate" || sub === "check") {
    const res = await apiSend<{ score: DeckScore; validation: ValidationResult }>(
      env,
      "POST",
      "/api/deck/evaluate",
      { decklist: options.list, format },
    );
    return { embeds: [sub === "rate" ? deckRateEmbed(res.score) : deckCheckEmbed(res.validation)] };
  }

  if (sub === "save") {
    const res = await apiSend<{ scores: { overall: number } | null }>(
      env,
      "POST",
      "/api/deck/save",
      { title: options.name, format, decklist: options.list },
      internalHeaders(env, discordId),
    );
    return { embeds: [deckSaveEmbed(options.name, res.scores?.overall)] };
  }

  return { content: "不明なコマンドです" };
}

async function metaCommand(
  sub: string,
  options: Record<string, string>,
  discordId: string,
  env: BotEnv,
): Promise<MessagePayload> {
  const format = await resolveFormat(env, discordId);

  if (sub === "tier") {
    const period = options.period ?? "4w";
    const res = await apiGet<{ tier_data: TierEntry[] }>(
      env,
      `/api/meta/tier?format=${format}&period=${encodeURIComponent(period)}`,
    );
    if (!res.tier_data || res.tier_data.length === 0) {
      return { content: "ティアデータがまだありません" };
    }
    return { embeds: [tierEmbed(format, res.tier_data)] };
  }

  if (sub === "deck") {
    const res = await apiGet<{
      archetype: string;
      stats: { total_entries: number; wins: number; top8: number } | null;
    }>(env, `/api/meta/archetype/${encodeURIComponent(options.name)}?format=${format}`);
    return { embeds: [archetypeEmbed(res.archetype, res.stats)] };
  }

  return { content: "不明なコマンドです" };
}
