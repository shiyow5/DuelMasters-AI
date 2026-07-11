/**
 * Worker エントリポイント
 * コマンドライン引数でジョブを実行
 */
const job = process.argv[2];

async function main() {
  switch (job) {
    case "rules":
      await import("./jobs/ingest-rules.js");
      break;
    case "cards":
      await import("./jobs/ingest-cards.js");
      break;
    case "regulations":
      await import("./jobs/ingest-regulations.js");
      break;
    case "tags": {
      const { runIngestTags } = await import("./jobs/ingest-tags.js");
      await runIngestTags({ onlyEmpty: !process.argv.includes("--all") });
      break;
    }
    default:
      console.log("使用法: tsx src/index.ts <rules|cards|regulations|tags>");
      console.log("  rules       - ルールPDF取り込み");
      console.log("  cards       - カードデータ取り込み");
      console.log("  regulations - 殿堂レギュレーション取り込み");
      console.log("  tags        - カード役割タグ付与 (--all で全カード)");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
