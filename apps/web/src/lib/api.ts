import { supabase } from "./supabase";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** ログイン中なら Supabase アクセストークンを Authorization に付ける (未ログイン時は付けない) */
async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

/** サーバーが返す具体的なエラー文言 (error / details) を優先して Error にする */
async function toApiError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    details?: string[];
  } | null;
  const detail = body?.details?.length ? `: ${body.details.join(", ")}` : "";
  return new Error(
    body?.error ? `${body.error}${detail}` : `API error: ${res.status} ${res.statusText}`,
  );
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

/** DELETE リクエスト (マイデッキ削除用) */
export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}
