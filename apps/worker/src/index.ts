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
    case "rulings": {
      const { runIngestRulings, parseRulingsArgs } = await import("./jobs/ingest-rulings.js");
      await runIngestRulings(parseRulingsArgs(process.argv.slice(3)));
      break;
    }
    case "tags": {
      const { runIngestTags } = await import("./jobs/ingest-tags.js");
      await runIngestTags({ onlyEmpty: !process.argv.includes("--all") });
      break;
    }
    case "faq": {
      const { runIngestFaq, parseFaqArgs } = await import("./jobs/ingest-faq.js");
      const parsed = parseFaqArgs(process.argv.slice(3));
      if (!parsed) {
        console.error("使用法: tsx src/index.ts faq <faq|ruling> <url> [url...]");
        process.exit(1);
      }
      await runIngestFaq(parsed.docType, parsed.urls);
      break;
    }
    case "snapshot": {
      const { runSnapshotMeta, parseSnapshotArgs } = await import("./jobs/snapshot-meta.js");
      const parsed = parseSnapshotArgs(process.argv.slice(3));
      if (!parsed) {
        console.error("使用法: tsx src/index.ts snapshot <original|advance> [weeks]");
        process.exit(1);
      }
      await runSnapshotMeta(parsed.format, parsed.weeks);
      break;
    }
    default:
      console.log("使用法: tsx src/index.ts <rules|cards|regulations|tags|faq|snapshot>");
      console.log("  rules       - ルールPDF取り込み");
      console.log("  cards       - カードデータ取り込み");
      console.log("  regulations - 殿堂レギュレーション取り込み");
      console.log("  tags        - カード役割タグ付与 (--all で全カード)");
      console.log("  faq         - FAQ/裁定取り込み <faq|ruling> <url...>");
      console.log("  snapshot    - メタスナップショット生成 <original|advance> [weeks]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
