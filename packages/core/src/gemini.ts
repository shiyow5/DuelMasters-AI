import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { z } from "zod";

/** @google/genai の Type enum を再エクスポート (responseSchema 構築用) */
export { Type } from "@google/genai";

let _client: GoogleGenAI | null = null;

// Cloudflare Workers には process.env が無く、API キーは binding 経由でしか渡せないため、
// リクエストのミドルウェアから注入できるようにする。未注入なら process.env にフォールバック。
let _apiKey: string | undefined;
export function configureGemini(cfg: { apiKey?: string }): void {
  if (cfg.apiKey) _apiKey = cfg.apiKey;
}

function getClient(): GoogleGenAI {
  if (!_client) {
    const apiKey = _apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

/** チャットモデル */
const CHAT_MODEL = "gemini-2.5-flash-lite";
/** 埋め込みモデル */
const EMBEDDING_MODEL = "gemini-embedding-001";
/** 埋め込みの次元数 */
const EMBEDDING_DIMENSIONS = 768;

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

  const response = await client.models.generateContent({
    model: CHAT_MODEL,
    contents,
    config,
  });

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
 * Zod 検証に失敗した場合は1回だけ再試行し、それでも失敗なら例外を投げる。
 */
export async function generateStructured<T>(
  prompt: string,
  zodSchema: z.ZodType<T>,
  options: StructuredOptions,
): Promise<T> {
  const client = getClient();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const config: Record<string, unknown> = {
      responseMimeType: "application/json",
      responseSchema: options.responseSchema,
    };
    if (options.systemPrompt) config.systemInstruction = options.systemPrompt;
    if (options.temperature !== undefined) config.temperature = options.temperature;

    const response = await client.models.generateContent({
      model: CHAT_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config,
    });
    const text = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    try {
      return zodSchema.parse(JSON.parse(text));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`構造化出力の検証に失敗しました: ${String(lastError)}`);
}

export { CHAT_MODEL, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
