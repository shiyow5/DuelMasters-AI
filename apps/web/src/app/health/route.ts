// 死活確認用エンドポイント（デプロイ後の疎通確認用）。
// 外部依存（DB など）には触れず、常に 200 と最小限の JSON を返す。
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { status: "ok" },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
