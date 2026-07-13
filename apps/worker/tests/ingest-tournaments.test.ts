import { describe, it, expect } from "vitest";
import {
  parseCsResultTitle,
  parseWeeklyRanking,
  parseEntryList,
  isWeeklyRankingTitle,
  weeklyRankingFormat,
  categoryPageUrls,
} from "../src/jobs/ingest-tournaments.js";

describe("parseCsResultTitle", () => {
  it("タイトルから大会名・日付・フォーマット・順位を取り出す", () => {
    const t =
      "【デュエマ オリジナルCS】「第89回 DMまめすけ杯(2026/7/11)」結果　白緑ウィリデが優勝　トリーヴァアルファディオスが準優勝　青黒デスパペットが3位入賞　ドロマーシーザーが4位入賞";
    expect(parseCsResultTitle(t)).toEqual({
      format: "original",
      event_name: "第89回 DMまめすけ杯",
      event_date: "2026-07-11",
      results: [
        { deck_archetype: "白緑ウィリデ", placement: 1 },
        { deck_archetype: "トリーヴァアルファディオス", placement: 2 },
        { deck_archetype: "青黒デスパペット", placement: 3 },
        { deck_archetype: "ドロマーシーザー", placement: 4 },
      ],
    });
  });

  it("アドバンスを advance に対応づける", () => {
    const t =
      "【デュエマ アドバンスCS】「第15回 DMゼロCS(2026/7/12)」結果　白緑ウィリデが優勝　赤黒邪王門が準優勝";
    const parsed = parseCsResultTitle(t);
    expect(parsed?.format).toBe("advance");
    expect(parsed?.event_date).toBe("2026-07-12");
  });

  it("同順位が重複したら空いている順位を順に割り当てる", () => {
    // 「3位入賞」が2つ = 3位タイ。ユニーク制約 (event,date,format,archetype,placement) で
    // 潰れないよう 3 と 4 に割り振る (入賞数を取りこぼさないため)。
    const t =
      "【デュエマ アドバンスCS】「第15回 DMゼロCS(2026/7/12)」結果　白緑ウィリデが優勝　赤黒邪王門が準優勝　トリーヴァアルファディオスが3位入賞　青黒デスパペットが3位入賞";
    expect(parseCsResultTitle(t)?.results).toEqual([
      { deck_archetype: "白緑ウィリデ", placement: 1 },
      { deck_archetype: "赤黒邪王門", placement: 2 },
      { deck_archetype: "トリーヴァアルファディオス", placement: 3 },
      { deck_archetype: "青黒デスパペット", placement: 4 },
    ]);
  });

  it("「ベスト4」を 3位・4位 に展開する (同じデッキが2つ入賞しても数を落とさない)", () => {
    const t =
      "【デュエマ オリジナルCS】「イケブクロ龍星杯(2026/7/11)」結果　4C邪眼帝が優勝　トリーヴァゴルギーオージャーが準優勝　4Cゴルファウンデーションがベスト4　4Cゴルファウンデーションがベスト4";
    expect(parseCsResultTitle(t)?.results).toEqual([
      { deck_archetype: "4C邪眼帝", placement: 1 },
      { deck_archetype: "トリーヴァゴルギーオージャー", placement: 2 },
      { deck_archetype: "4Cゴルファウンデーション", placement: 3 },
      { deck_archetype: "4Cゴルファウンデーション", placement: 4 },
    ]);
  });

  it("大会名に括弧が含まれても日付は末尾の括弧から取る", () => {
    const t =
      "【デュエマ オリジナルCS】「シャントCS(第2回) in 三洋堂(2026/7/12)」結果　逆アポロが優勝";
    const parsed = parseCsResultTitle(t);
    expect(parsed?.event_name).toBe("シャントCS(第2回) in 三洋堂");
    expect(parsed?.event_date).toBe("2026-07-12");
  });

  it("1つのデッキが複数入賞したときの「準優勝・3位入賞」を展開する", () => {
    // 実在する形。名前自体に「・」を含むもの (ボルメテウス・ソル) と両立する必要がある。
    const t =
      "【デュエマ オリジナルCS】「第1回テストCS(2026/7/12)」結果　クロムウェル＆ボルメテウス・ソル入り赤白ウィリデが優勝　ミラダンテ槍＆ロマネスク入り白緑ウィリデが準優勝・3位入賞";
    expect(parseCsResultTitle(t)?.results).toEqual([
      { deck_archetype: "クロムウェル＆ボルメテウス・ソル入り赤白ウィリデ", placement: 1 },
      { deck_archetype: "ミラダンテ槍＆ロマネスク入り白緑ウィリデ", placement: 2 },
      { deck_archetype: "ミラダンテ槍＆ロマネスク入り白緑ウィリデ", placement: 3 },
    ]);
  });

  it("2ブロックは対応フォーマット外なので null を返す", () => {
    const t = "【デュエマ 2ブロックCS】「イケブクロ龍星杯(2026/7/11)」結果　4C邪眼帝が優勝";
    expect(parseCsResultTitle(t)).toBeNull();
  });

  it("CS 結果でないタイトルは null を返す", () => {
    expect(parseCsResultTitle("オリジナルCS入賞数ランキング(7/6～7/12)")).toBeNull();
    expect(parseCsResultTitle("2026年7月発売のTCG新商品まとめ")).toBeNull();
    expect(parseCsResultTitle("")).toBeNull();
  });
});

describe("isWeeklyRankingTitle / weeklyRankingFormat", () => {
  it("記事本来の (長い) タイトルを見分ける", () => {
    // カテゴリ一覧の記事リンクはこの形。サイドバー (人気の記事) だけが短い形を使う。
    const t = "【デュエマ オリジナルCS】「入賞数ランキング(7/6～7/12)」 逆札篇第2弾環境…";
    expect(isWeeklyRankingTitle(t)).toBe(true);
    expect(weeklyRankingFormat(t)).toBe("original");
    expect(
      weeklyRankingFormat(
        "【デュエマ アドバンスCS】「入賞数ランキング(7/6～7/12)」 バイクが再びトップに",
      ),
    ).toBe("advance");
  });

  it("サイドバーの (短い) タイトルも見分ける", () => {
    expect(weeklyRankingFormat("オリジナルCS入賞数ランキング(7/6～7/12)")).toBe("original");
    expect(weeklyRankingFormat("アドバンスCS入賞数ランキング(7/6～7/12)")).toBe("advance");
  });

  it("2ブロックは対応フォーマット外", () => {
    expect(isWeeklyRankingTitle("2ブロックCS入賞数ランキング(4/13～6/14)")).toBe(false);
    expect(isWeeklyRankingTitle("【デュエマ 2ブロックCS】「入賞数ランキング(4/13～6/14)」 …")).toBe(
      false,
    );
  });

  it("CS 結果記事はランキングではない", () => {
    expect(
      isWeeklyRankingTitle("【デュエマ オリジナルCS】「第89回 DMまめすけ杯(2026/7/11)」結果"),
    ).toBe(false);
  });
});

describe("categoryPageUrls", () => {
  it("サフィックス無しのページを先頭に含める", () => {
    // FC2 の「現在のページ」はサフィックス無し。-1 から始めると最新記事を取り逃す
    // (実測: blog-category-12.html にしか無い CS 記事が4本あった)。
    expect(categoryPageUrls(3)).toEqual([
      "https://supersolenoid.jp/blog-category-12.html",
      "https://supersolenoid.jp/blog-category-12-1.html",
      "https://supersolenoid.jp/blog-category-12-2.html",
      "https://supersolenoid.jp/blog-category-12-3.html",
    ]);
  });
});

describe("parseWeeklyRanking", () => {
  // 実記事 (blog-entry-47044) の本文を再現したもの。入賞数の合計 = 母数 274 になる。
  const BODY = `
最新セット：逆札篇第2弾「燃えろ禁断！逆転のドギラゴン革命」
集計期間：2026/7/6～2026/7/12
母数：274
入賞数1位 (50件、18.2％)
・ウィリデ(白緑42、白青6、赤白2)
入賞数2位 (28件、10.2％)
・ダーバンデ(全てトリーヴァt赤)
入賞数11位 (8件、2.9％)
・墓地ソースゾロアスタート(全て黒緑t赤)
・ゴルギーオージャー(全てトリーヴァ)
母数1のデッキ (4.7％)
・ガイアハザード退化
・赤単速攻
`.trim();

  it("集計期間・母数・アーキタイプ別入賞数を取り出す", () => {
    const r = parseWeeklyRanking(BODY, "original");
    expect(r).not.toBeNull();
    expect(r?.period_start).toBe("2026-07-06");
    expect(r?.period_end).toBe("2026-07-12");
    expect(r?.total_entries).toBe(274);
  });

  it("順位が同着なら並んだアーキタイプ全部に同じ件数を与える", () => {
    const r = parseWeeklyRanking(BODY, "original");
    expect(r?.entries).toContainEqual({ deck_archetype: "墓地ソースゾロアスタート", entries: 8 });
    expect(r?.entries).toContainEqual({ deck_archetype: "ゴルギーオージャー", entries: 8 });
  });

  it("アーキタイプ名から色の内訳カッコを落とす", () => {
    const r = parseWeeklyRanking(BODY, "original");
    expect(r?.entries).toContainEqual({ deck_archetype: "ウィリデ", entries: 50 });
    expect(r?.entries).toContainEqual({ deck_archetype: "ダーバンデ", entries: 28 });
  });

  it("「母数1のデッキ」節のアーキタイプは1件として数える", () => {
    const r = parseWeeklyRanking(BODY, "original");
    expect(r?.entries).toContainEqual({ deck_archetype: "ガイアハザード退化", entries: 1 });
    expect(r?.entries).toContainEqual({ deck_archetype: "赤単速攻", entries: 1 });
  });

  it("集計期間が無い本文は null を返す", () => {
    expect(parseWeeklyRanking("母数：274\n入賞数1位 (50件)\n・ウィリデ", "original")).toBeNull();
  });

  it("データ節が終わったら以降の「・」行を拾わない", () => {
    // 記事の下にはコメント欄の注意書きが「・」付きで並んでいる。本文抽出が緩いと
    // これをアーキタイプとして数えてしまい、入賞数の合計が母数とずれる (実際にずれた)。
    const body = `${BODY}
今週も取り急ぎデッキタイプの集計を行いました。環境分析にお役立てください。
コメントの投稿
・誹謗中傷や不謹慎な書き込みはお控えください。
・管理人判断で削除・規制及びプロバイダ通報を行う場合がございます。`;
    const r = parseWeeklyRanking(body, "original");
    const names = r?.entries.map((e) => e.deck_archetype) ?? [];
    expect(names).not.toContain("誹謗中傷や不謹慎な書き込みはお控えください。");
    expect(names).not.toContain("管理人判断で削除・規制及びプロバイダ通報を行う場合がございます。");
    expect(names).toContain("赤単速攻"); // データ節の最後は拾えている
  });
});

describe("parseEntryList", () => {
  it("カテゴリ一覧 HTML から記事 URL とタイトルを取り出す", () => {
    const html = `
      <a href="https://supersolenoid.jp/blog-entry-47043.html">【デュエマ オリジナルCS】「第89回 DMまめすけ杯(2026/7/11)」結果　白緑ウィリデが優勝</a>
      <a href="https://supersolenoid.jp/blog-entry-47044.html">オリジナルCS入賞数ランキング(7/6～7/12)</a>
      <a href="https://example.com/other">外部リンク</a>
    `;
    expect(parseEntryList(html)).toEqual([
      {
        url: "https://supersolenoid.jp/blog-entry-47043.html",
        title:
          "【デュエマ オリジナルCS】「第89回 DMまめすけ杯(2026/7/11)」結果　白緑ウィリデが優勝",
      },
      {
        url: "https://supersolenoid.jp/blog-entry-47044.html",
        title: "オリジナルCS入賞数ランキング(7/6～7/12)",
      },
    ]);
  });

  it("同じ記事へのリンクが複数あっても1件にまとめる", () => {
    const html = `
      <a href="https://supersolenoid.jp/blog-entry-1.html">タイトルA</a>
      <a href="https://supersolenoid.jp/blog-entry-1.html"><img src="x.png"></a>
    `;
    expect(parseEntryList(html)).toEqual([
      { url: "https://supersolenoid.jp/blog-entry-1.html", title: "タイトルA" },
    ]);
  });

  it("HTML エンティティを戻す", () => {
    const html = `<a href="https://supersolenoid.jp/blog-entry-2.html">A&amp;B</a>`;
    expect(parseEntryList(html)[0].title).toBe("A&B");
  });
});
