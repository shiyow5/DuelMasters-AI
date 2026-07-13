/**
 * Worker エントリポイント
 * コマンドライン引数でジョブを実行
 */
const job = process.argv[2];

async function main() {
  switch (job) {
    case "rules": {
      const { runIngestRules } = await import("./jobs/ingest-rules.js");
      await runIngestRules();
      break;
    }
    case "cards": {
      const { runIngestCards, parseCardsArgs } = await import("./jobs/ingest-cards.js");
      await runIngestCards(parseCardsArgs(process.argv.slice(3)));
      break;
    }
    case "regulations": {
      const { runIngestRegulations } = await import("./jobs/ingest-regulations.js");
      await runIngestRegulations();
      break;
    }
    case "rulings": {
      const { runIngestRulings, parseRulingsArgs } = await import("./jobs/ingest-rulings.js");
      await runIngestRulings(parseRulingsArgs(process.argv.slice(3)));
      break;
    }
    case "audit-rulings": {
      const { runAuditRulings, parseAuditArgs } = await import("./jobs/audit-rulings.js");
      await runAuditRulings(parseAuditArgs(process.argv.slice(3)));
      break;
    }
    case "deprecate": {
      const { runDeprecateRulings } = await import("./jobs/deprecate-rulings.js");
      await runDeprecateRulings();
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
    case "tournaments": {
      const { runIngestTournaments, parseTournamentsArgs } =
        await import("./jobs/ingest-tournaments.js");
      await runIngestTournaments(parseTournamentsArgs(process.argv.slice(3)));
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
      console.log(
        "使用法: tsx src/index.ts <rules|cards|regulations|rulings|audit-rulings|deprecate|tags|faq|tournaments|snapshot>",
      );
      console.log("  rules       - ルールPDF取り込み");
      console.log("  cards       - カードデータ取り込み");
      console.log("  regulations - 殿堂レギュレーション取り込み");
      console.log("  rulings     - 裁定Q&A取り込み");
      console.log("  audit-rulings - 現行ルールと矛盾する裁定を検出 (--limit=N --out=path)");
      console.log("  deprecate   - レビュー済みの廃止裁定一覧を DB に反映");
      console.log("  tags        - カード役割タグ付与 (--all で全カード)");
      console.log("  faq         - FAQ/裁定取り込み <faq|ruling> <url...>");
      console.log("  tournaments - 大会結果取り込み (--pages=N で遡るページ数)");
      console.log("  snapshot    - メタスナップショット生成 <original|advance> [weeks]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
