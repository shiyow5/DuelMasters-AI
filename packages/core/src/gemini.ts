import { GoogleGenAI, type Content, type Part } from "@google/genai";

let _client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GEMINI_API_KEY;
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
  options: ChatOptions = {}
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

export { CHAT_MODEL, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
