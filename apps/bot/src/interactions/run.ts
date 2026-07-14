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

// api は全エンドポイントがログイン必須。Discord ユーザーは Supabase ログインを持たないため、
// bot は内部キー + Discord ID で認証する。1つでも付け忘れるとそのコマンドが 401 になるので、
// ヘッダの付与は呼び出し側に任せず、この2つのヘルパに集約する。
const apiGet = <T>(env: BotEnv, path: string, discordId: string) =>
  apiFetch<T>(env, path, { method: "GET", headers: internalHeaders(env, discordId) });

const apiSend = <T>(
  env: BotEnv,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  discordId: string,
) =>
  apiFetch<T>(env, path, {
    method,
    body: JSON.stringify(body),
    headers: internalHeaders(env, discordId),
  });

/** ユーザーのフォーマット設定。取得に失敗したら既定 (オリジナル) に倒す。 */
async function resolveFormat(env: BotEnv, discordId: string): Promise<string> {
  try {
    const res = await apiGet<{ format: string }>(env, "/api/user/settings", discordId);
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

/** /api/chat の応答。toolFailures はツールが失敗したときだけ付く (#109)。 */
interface ChatResponse {
  response: string;
  toolFailures?: string[];
}

/** 失敗表示用の名詞ラベル (web の tools.ts と同じ方針)。 */
const TOOL_NOUNS: Record<string, string> = {
  search_rules: "ルール検索",
  search_cards: "カード検索",
  evaluate_deck: "デッキ評価",
  build_deck: "デッキ構築",
  get_tier_list: "環境データの取得",
  suggest_improvements: "改善案の作成",
};

/**
 * ツールが失敗したら、その事実を回答に添える (#109)。
 *
 * **握り潰さない。** 隠すと、データで裏付けられていない回答が「普通の回答」に見える。
 * モデルは失敗したツールの穴を記憶で埋めようとするので、利用者はそれを信じてしまう
 * (#112 で実際に起きた: 全ツールが CONNECTION_ENDED で死んでいるのに、誤ったカード
 *  テキストが自信たっぷりに返っていた)。
 */
export function withToolFailureNotice(res: ChatResponse): string {
  const failures = res.toolFailures ?? [];
  if (failures.length === 0) return res.response;
  const nouns = [...new Set(failures)].map((n) => TOOL_NOUNS[n] ?? n).join(" / ");
  return `⚠️ **${nouns}に失敗しました。この回答はデータで裏付けられていません。**\n\n${res.response}`;
}

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
    await apiSend(env, "PUT", "/api/user/settings", { format }, discordId);
    return { content: `フォーマットを **${formatLabel(format)}** に設定しました` };
  }

  if (sub === "rule") {
    const res = await apiSend<ChatResponse>(
      env,
      "POST",
      "/api/chat",
      { message: options.question, mode: "rule" },
      discordId,
    );
    return { embeds: [ruleEmbed(withToolFailureNotice(res))] };
  }

  if (sub === "chat") {
    const res = await apiSend<ChatResponse>(
      env,
      "POST",
      "/api/chat",
      { message: options.message, mode: "integrated" },
      discordId,
    );
    return { content: truncate(withToolFailureNotice(res), 2000) };
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
      discordId,
    );
    return { embeds: [deckBuildEmbed(theme, res.entries)] };
  }

  if (sub === "rate" || sub === "check") {
    const res = await apiSend<{ score: DeckScore; validation: ValidationResult }>(
      env,
      "POST",
      "/api/deck/evaluate",
      { decklist: options.list, format },
      discordId,
    );
    return { embeds: [sub === "rate" ? deckRateEmbed(res.score) : deckCheckEmbed(res.validation)] };
  }

  if (sub === "save") {
    const res = await apiSend<{ scores: { overall: number } | null }>(
      env,
      "POST",
      "/api/deck/save",
      { title: options.name, format, decklist: options.list },
      discordId,
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
      discordId,
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
    }>(env, `/api/meta/archetype/${encodeURIComponent(options.name)}?format=${format}`, discordId);
    return { embeds: [archetypeEmbed(res.archetype, res.stats)] };
  }

  return { content: "不明なコマンドです" };
}
