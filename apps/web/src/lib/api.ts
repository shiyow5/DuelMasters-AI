import type { Citation } from "./types";
import { supabase } from "./supabase";
import { createSseParser } from "./sse";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** ログイン中なら Supabase アクセストークンを Authorization に付ける (未ログイン時は付けない) */
async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

/** HTTP ステータスを持つエラー。UI が 401/429 を出し分けるのに使う。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * ステータスごとの案内文。サーバーの文言をそのまま出すと
 * 「ログインが必要です」だけになり、ユーザーが次に何をすればいいか分からない。
 */
function statusMessage(status: number): string | null {
  if (status === 401) return "ログインの有効期限が切れました。再度ログインしてください。";
  if (status === 403) return "この操作を行う権限がありません。";
  if (status === 429) return "リクエストが多すぎます。しばらく待ってからもう一度お試しください。";
  if (status >= 500) return "サーバーで問題が発生しました。時間をおいて再度お試しください。";
  return null;
}

/** サーバーが返す具体的なエラー文言 (error / details) を優先して ApiError にする */
async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    details?: string[];
  } | null;

  const generic = statusMessage(res.status);
  // 400 番台のバリデーションエラーはサーバーの文言のほうが具体的。
  // 401/429/5xx は「次に何をすべきか」を伝える定型文を優先する。
  if (generic) return new ApiError(generic, res.status);

  const detail = body?.details?.length ? `: ${body.details.join(", ")}` : "";
  return new ApiError(
    body?.error ? `${body.error}${detail}` : `エラーが発生しました (${res.status})`,
    res.status,
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

/** PUT / PATCH (会話のリネーム・フィードバック)。 */
async function apiWrite<T>(method: "PUT" | "PATCH", path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

export const apiPut = <T>(path: string, body: unknown) => apiWrite<T>("PUT", path, body);
export const apiPatch = <T>(path: string, body: unknown) => apiWrite<T>("PATCH", path, body);

/** SSE で受け取るイベント (apps/api の /api/chat/stream と対応) */
export type ChatStreamEvent =
  | { type: "token"; text: string }
  /** ツール実行が決まった。`args` から「何を」検索しているかを進行表示に出す (#98)。 */
  | { type: "tool"; name: string; args?: Record<string, unknown> }
  /** グラフのノードを1つ通過した (retrieve / agent / tools / finalize)。 */
  | { type: "phase"; node: string }
  | { type: "done"; result: ChatResult }
  /** サーバーが発言を保存した (#110)。この ID が無いと 👍 を送れない。 */
  | { type: "saved"; messageId: string }
  /** ツールが失敗した (#109)。**隠さない** — 隠すと利用者には普通の回答に見える。 */
  | { type: "toolError"; name: string }
  | { type: "error"; message: string };

export interface ChatResult {
  response: string;
  citations?: Citation[];
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  mode?: string;
  /** 実際にデータを取れたツールの数 (#109)。toolCalls は「呼ぼうとした」だけ。 */
  toolSuccesses?: number;
  /** 失敗したツール名 (#109)。空でないなら、この回答は根拠が欠けている。 */
  toolFailures?: string[];
}

/**
 * チャットをストリーミングで実行する。
 *
 * 表示する回答は必ず `done` の `result.response` を使うこと。`token` は進行表示専用で、
 * エージェントがツール呼び出し前に喋った前置きも含まれる (`tool` を受けたら捨てる)。
 */
export async function streamChat(
  body: unknown,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError("ストリームを受信できませんでした", res.status);

  // done も error も来ないままストリームが閉じることがある (Worker/プロキシがヘッダだけ返して
  // 切る、最後のフレームが壊れて捨てられる、など)。そのまま正常終了すると UI の streaming
  // フラグが下りず、タイピング表示が永久に残って何も起きない。終端イベントの有無を見張る。
  let terminated = false;

  const parser = createSseParser((event, data) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // 壊れたフレームは捨てる (done さえ届けば回答は出せる)
    }
    if (event === "done" || event === "error") terminated = true;
    onEvent({ type: event, ...payload } as ChatStreamEvent);
  });

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.end();
  } finally {
    reader.releaseLock();
  }

  if (!terminated) {
    onEvent({
      type: "error",
      message: "回答の途中で接続が切れました。もう一度お試しください。",
    });
  }
}
