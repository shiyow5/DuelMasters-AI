import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { z } from "zod";

/** @google/genai の Type enum を再エクスポート (responseSchema 構築用) */
export { Type } from "@google/genai";

let _client: GoogleGenAI | null = null;

// Cloudflare Workers には process.env が無く、API キーは binding 経由でしか渡せないため、
// リクエストのミドルウェアから注入できるようにする。未注入なら process.env にフォールバック。
// モデルチェーンも同様に注入・環境変数で上書きできる。
let _apiKey: string | undefined;
let _chatModels: string[] | undefined;
let _structuredModels: string[] | undefined;
export function configureGemini(cfg: {
  apiKey?: string;
  chatModels?: string[];
  structuredModels?: string[];
}): void {
  if (cfg.apiKey) _apiKey = cfg.apiKey;
  if (cfg.chatModels?.length) _chatModels = cfg.chatModels;
  if (cfg.structuredModels?.length) _structuredModels = cfg.structuredModels;
}

/**
 * env を安全に読む。`process` が存在しない runtime (nodejs_compat 無しの Cloudflare
 * Worker 等) では未設定として扱い、参照だけで ReferenceError を投げないようにする。
 * (未注入時は configureGemini による binding 注入か既定値へフォールバックさせる)
 */
function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function getClient(): GoogleGenAI {
  if (!_client) {
    const apiKey = _apiKey ?? readEnv("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

// モデルフォールバック方針:
// - コスト最優先。無料枠のある Gemma を主にし、レート制限(429)時に低コストの
//   gemini-2.5-flash-lite へ自動フォールバックする。
// - 構造化出力(responseSchema)は Gemma が非対応のため Gemini 系のみで構成する。
// - 埋め込みは別モデルへ切り替えるとベクトル空間が変わり、既存データとの類似検索が
//   壊れるため、フォールバック対象にしない(単一モデル固定)。
// チェーンは環境変数 (GEMINI_CHAT_MODELS / GEMINI_STRUCTURED_MODELS, カンマ区切り) や
// configureGemini() で上書きできる。

/** チャット/ツール応答のモデルチェーン (無料優先 → 低コスト) */
const DEFAULT_CHAT_MODELS = ["gemma-4-31b-it", "gemini-2.5-flash-lite"];
/** 構造化出力のモデルチェーン (Gemini 系のみ。Gemma は responseSchema 非対応) */
const DEFAULT_STRUCTURED_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

/** 後方互換: 主チャットモデル (チェーン先頭) */
const CHAT_MODEL = DEFAULT_CHAT_MODELS[0];
/** 埋め込みモデル (フォールバック非対象: ベクトル空間の互換性のため固定) */
const EMBEDDING_MODEL = "gemini-embedding-001";
/** 埋め込みの次元数 */
const EMBEDDING_DIMENSIONS = 768;

/** カンマ区切りのモデル env をパースする (空なら undefined)。Workers の env 注入でも再利用する。 */
export function parseModelEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

// 既定チェーンは共有参照を返さずコピーする (呼び出し側の破壊的変更でプロセス全体の
// 既定が壊れるのを防ぐ)。注入値/env 由来は既に都度生成された配列なのでそのまま返す。
function getChatModels(): string[] {
  return _chatModels ?? parseModelEnv(readEnv("GEMINI_CHAT_MODELS")) ?? [...DEFAULT_CHAT_MODELS];
}

function getStructuredModels(): string[] {
  return (
    _structuredModels ??
    parseModelEnv(readEnv("GEMINI_STRUCTURED_MODELS")) ?? [...DEFAULT_STRUCTURED_MODELS]
  );
}

/**
 * レート制限(429/RESOURCE_EXHAUSTED)や一時的過負荷(503/UNAVAILABLE)など、
 * 別モデルへ切り替える価値があるエラーかを判定する。
 */
export function isRetryableModelError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { status?: number; code?: number; message?: string };
  const status = e.status ?? e.code;
  if (status === 429 || status === 503) return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|rate limit|quota|overloaded/i.test(msg);
}

/**
 * モデルチェーンを順に試し、レート制限/過負荷なら次のモデルへフォールバックする。
 * 非リトライ系エラー(400 等)は即座に投げる。全モデル失敗時は最後のエラーを投げる。
 */
async function withModelFallback<T>(
  models: string[],
  run: (model: string) => Promise<T>,
): Promise<T> {
  if (models.length === 0) {
    throw new Error("withModelFallback: モデルが1つも指定されていません");
  }
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    try {
      return await run(models[i]);
    } catch (err) {
      lastError = err;
      const hasNext = i < models.length - 1;
      if (hasNext && isRetryableModelError(err)) {
        console.warn(
          `[gemini] モデル ${models[i]} がレート制限/過負荷のため ${models[i + 1]} にフォールバックします`,
        );
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export interface ChatOptions {
  systemPrompt?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
}

/** Gemini チャット完了 */
export async function chat(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  options: ChatOptions = {},
): Promise<ChatResponse> {
  const client = getClient();

  const contents: Content[] = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }] as Part[],
  }));

  const config: Record<string, unknown> = {};
  if (options.temperature !== undefined) {
    config.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    config.maxOutputTokens = options.maxTokens;
  }
  if (options.systemPrompt) {
    config.systemInstruction = options.systemPrompt;
  }
  if (options.tools && options.tools.length > 0) {
    config.tools = [
      {
        functionDeclarations: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  const response = await withModelFallback(getChatModels(), (model) =>
    client.models.generateContent({ model, contents, config }),
  );

  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) {
    return { text: "" };
  }

  let text = "";
  const toolCalls: ChatResponse["toolCalls"] = [];

  for (const part of candidate.content.parts) {
    if (part.text) {
      text += part.text;
    }
    if (part.functionCall) {
      toolCalls.push({
        name: part.functionCall.name ?? "",
        args: (part.functionCall.args as Record<string, unknown>) ?? {},
      });
    }
  }

  return {
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/** 埋め込みベクトル生成 */
export async function embed(texts: string[]): Promise<number[][]> {
  const client = getClient();

  const response = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: texts.map((t) => ({ parts: [{ text: t }] })),
    config: {
      outputDimensionality: EMBEDDING_DIMENSIONS,
    },
  });

  return (response.embeddings ?? []).map((e) => e.values ?? []);
}

/** 単一テキストの埋め込み */
export async function embedSingle(text: string): Promise<number[]> {
  const results = await embed([text]);
  return results[0] ?? [];
}

export interface StructuredOptions {
  /** @google/genai の Schema (OpenAPI サブセット。Type enum を使用) */
  responseSchema: Record<string, unknown>;
  systemPrompt?: string;
  temperature?: number;
}

/**
 * JSON 強制出力 + Zod 検証付きの生成。
 * 各モデル内で Zod 検証に失敗したら1回だけ再試行し、2回とも失敗なら例外を投げる。
 * レート制限(429)等では構造化モデルチェーン (getStructuredModels) の次モデルへ
 * フォールバックする (検証失敗自体はフォールバック対象外)。
 */
export async function generateStructured<T>(
  prompt: string,
  zodSchema: z.ZodType<T>,
  options: StructuredOptions,
): Promise<T> {
  const client = getClient();
  const config: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseSchema: options.responseSchema,
  };
  if (options.systemPrompt) config.systemInstruction = options.systemPrompt;
  if (options.temperature !== undefined) config.temperature = options.temperature;

  // モデルチェーン: レート制限時は次モデルへ。各モデル内で JSON 検証を最大2回試行する。
  return withModelFallback(getStructuredModels(), async (model) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config,
      });
      const text =
        response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      try {
        return zodSchema.parse(JSON.parse(text));
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`構造化出力の検証に失敗しました: ${String(lastError)}`);
  });
}

export {
  CHAT_MODEL,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  DEFAULT_CHAT_MODELS as CHAT_MODEL_CHAIN,
  DEFAULT_STRUCTURED_MODELS as STRUCTURED_MODEL_CHAIN,
};
