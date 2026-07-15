import type { Context } from "hono";
import type { z } from "zod";

/**
 * リクエストボディを zod で検証し、失敗時は 400 レスポンスを返す (ルート共通)。
 *
 * 成功なら `{ ok: true, data }`、失敗なら `{ ok: false, res }` を返す。
 * 呼び出し側は `if (!body.ok) return body.res;` で早期リターンする。
 */
export async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json(
        {
          error: "リクエストが不正です",
          details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
        400,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}
