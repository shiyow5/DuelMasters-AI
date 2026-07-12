import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { Runnable } from "@langchain/core/runnables";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseMessageLike } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

// エージェント (ツール呼び出し) 用モデルチェーン。両方とも無料枠あり。
// flash-lite を主にするのは、Gemma 4 が複数ターンのツール呼び出しで収束せず同じツールを
// 呼び続ける (空・低速応答) 問題があるため。flash-lite はツール結果を受けて1回で最終回答する。
// 無料枠優先の意図は維持 (flash-lite の無料枠 → 429 で Gemma の別無料枠へ)。
// モデル ID は実 API で疎通確認済み (2026-07)。gemini-2.5-* は 404 (提供終了) のため不可。
const DEFAULT_CHAT_MODELS = ["gemini-3.1-flash-lite", "gemma-4-31b-it"];

// Cloudflare Workers には process.env が無いため、api のミドルウェアから注入できるようにする。
let _apiKey: string | undefined;
let _chatModels: string[] | undefined;

export function configureAgent(cfg: { apiKey?: string; chatModels?: string[] }): void {
  if (cfg.apiKey) _apiKey = cfg.apiKey;
  if (cfg.chatModels?.length) _chatModels = cfg.chatModels;
}

/** process 未定義の runtime でも安全に env を読む。 */
function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function parseModelList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function getApiKey(): string {
  const key = _apiKey ?? readEnv("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

function getChatModels(): string[] {
  return _chatModels ?? parseModelList(readEnv("GEMINI_CHAT_MODELS")) ?? [...DEFAULT_CHAT_MODELS];
}

/** tools を bind し、コスト優先フォールバック付きのチャットモデル runnable を返す。 */
export function buildChatModel(
  tools: StructuredToolInterface[],
): Runnable<BaseMessageLike[], BaseMessage> {
  const apiKey = getApiKey();
  // maxRetries を絞る: 既定(6)+ withFallbacks + ツールループの複合で長時間ハングし得るため。
  const bound = getChatModels().map((model) =>
    new ChatGoogleGenerativeAI({ apiKey, model, temperature: 0.3, maxRetries: 2 }).bindTools(tools),
  );
  const [primary, ...rest] = bound;
  return rest.length > 0 ? primary.withFallbacks({ fallbacks: rest }) : primary;
}
