/**
 * AGENT_TOOLS の JSON Schema を「Gemini に送られる形」でダンプする (zod 3→4 比較用)。
 * 変換は @langchain/google-genai の schemaToGenerativeAIParameters と同じ手順
 * (@langchain/core の toJsonSchema → additionalProperties/$schema/strict を除去)。
 * 同関数は package の exports に無く import できないため、同等処理を再実装している。
 * 使い方: pnpm --filter @dm-ai/agent exec tsx eval/dump-tool-schemas.ts [--raw]
 */
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { AGENT_TOOLS } from "../src/tools.js";

const raw = process.argv.includes("--raw");

function strip(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(strip);
  if (typeof obj === "object" && obj !== null) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "additionalProperties" || k === "$schema" || k === "strict") continue;
      o[k] = strip(v);
    }
    return o;
  }
  return obj;
}

const out = AGENT_TOOLS.map((t) => {
  const js = toJsonSchema(t.schema);
  return { name: t.name, parameters: raw ? js : strip(js) };
});
console.log(JSON.stringify(out, null, 2));
