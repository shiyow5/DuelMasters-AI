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
    default:
      console.log("使用法: tsx src/index.ts <rules|cards|regulations>");
      console.log("  rules       - ルールPDF取り込み");
      console.log("  cards       - カードデータ取り込み");
      console.log("  regulations - 殿堂レギュレーション取り込み");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
