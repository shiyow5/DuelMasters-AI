import { describe, it, expect } from "vitest";
import {
  parseRecipeTitle,
  parseRecipeBody,
  parseRecipeEntryList,
  recipeCategoryPageUrls,
  exceedsSkipRate,
  parseMaxSkipRate,
  DEFAULT_MAX_SKIP_RATE,
} from "../src/jobs/ingest-deneblog.js";

describe("parseRecipeTitle", () => {
  it("タイトルから大会名・順位・デッキ名・プレイヤーを取り出す", () => {
    const t = "【 #デュエマCS入賞デッキレシピ 】トレカラインCS優勝　サガループ　🍣mofura🍣さん";
    expect(parseRecipeTitle(t)).toEqual({
      event_name: "トレカラインCS",
      placement_label: "優勝",
      deck_name: "サガループ",
      player: "🍣mofura🍣",
    });
  });

  it("プレイヤー名に半角スペースが入っていてもデッキ名を取り違えない", () => {
    // フィールドの区切りは**全角スペース**。半角で割ると「DOplayer」をデッキ名にしてしまう
    // (実測でこの取り違えが起きた)。
    const t =
      "【 #デュエマCS入賞デッキレシピ 】デュエマYCSベスト8　ゼニスガチャ　DOplayer とらっちさん";
    expect(parseRecipeTitle(t)).toEqual({
      event_name: "デュエマYCS",
      placement_label: "ベスト8",
      deck_name: "ゼニスガチャ",
      player: "DOplayer とらっち",
    });
  });

  it("大会名に「回」や「in」が入っていても順位だけを切り離す", () => {
    const t =
      "【 #デュエマCS入賞デッキレシピ 】第32回出張こあら杯inミトロコ3位　シャコガイル入り創世竜　KANADEさん";
    expect(parseRecipeTitle(t)).toEqual({
      event_name: "第32回出張こあら杯inミトロコ",
      placement_label: "3位",
      deck_name: "シャコガイル入り創世竜",
      player: "KANADE",
    });
  });

  it("全角数字のベストN を順位として扱う", () => {
    const t = "【 #デュエマCS入賞デッキレシピ 】ひろさきCSベスト４　赤単フミガルド　壽さん";
    expect(parseRecipeTitle(t)).toMatchObject({
      event_name: "ひろさきCS",
      placement_label: "ベスト４",
      deck_name: "赤単フミガルド",
    });
  });

  it("CS入賞デッキレシピ以外の記事は null", () => {
    expect(parseRecipeTitle("このブログについて")).toBeNull();
    expect(
      parseRecipeTitle("◆　広告の掲載依頼や、プロモーション記事・動画の作成について"),
    ).toBeNull();
  });

  it("順位が読めないタイトルは null (推測しない)", () => {
    expect(
      parseRecipeTitle("【 #デュエマCS入賞デッキレシピ 】謎の大会　謎デッキ　誰かさん"),
    ).toBeNull();
  });
});

/**
 * 実記事の構造を写したフィクスチャ。募集の定型文の前後に画像が1枚ずつ来るのが要点。
 *
 * `era` で新旧を切り替える。**定型文は時期で変わっている**:
 * - new: 「※もし1ヶ月以上掲載が行われていない場合は、…よりお問い合わせ下さい。」が**ある**
 * - old: それが**無い**(2026年前半までの記事)。ここをアンカーにしていたため本番で
 *   古い記事 41/117 件を取りこぼした。
 * どちらにも「応募方法はこちら」はある。
 */
function bodyHtml(opts: {
  eyecatch: string;
  decklist: string;
  participants?: string;
  era?: "new" | "old";
}): string {
  const contactLine =
    opts.era === "old"
      ? ""
      : `※もし1ヶ月以上掲載が行われていない場合は、<a href="/form">メールフォーム</a>よりお問い合わせ下さい。<br>`;
  return `
  <div class="ently_body">
    <div class="entry_date">2026.07.13 16:21</div>
    <h1>【 #デュエマCS入賞デッキレシピ 】トレカラインCS優勝　サガループ　🍣mofura🍣さん</h1>
    <a href="/?tag=%E3%83%87%E3%83%83%E3%82%AD" title="関連する記事">デッキレシピ</a>
    <div class="ently_text">
      <a href="${opts.eyecatch}"><img src="${opts.eyecatch.replace(".jpg", "s.jpg")}"></a>
      サガループ　🍣mofura🍣さん<br>
      ※有志の方よりデッキレシピを提供して頂いてはじめて成り立つコンテンツです。<br>
      公認大会優勝・CS入賞デッキレシピ募集中！<br>
      →<a href="/apply">応募方法はこちら。</a>（タップすると移動します。）<br>
      ${contactLine}
      トレカラインCS優勝　サガループ　🍣mofura🍣さん<br>
      <a href="${opts.decklist}"><img src="${opts.decklist.replace(".jpg", "s.jpg")}"></a><br>
      ${opts.participants ?? ""}
      <p>デュエ祭り・非公認大会で優勝、CSでベスト８以内入賞を収めたデッキレシピを募集中です。（参加人数6名以上ならOK）</p>
    </div>
    <div class="fc2relate"><div class="relate_entry">関連記事</div></div>
  </div>`;
}

const DECKLIST = "https://blog-imgs-201.fc2.com/d/e/n/deneblog1/2026071316204648c.jpg";

describe("parseRecipeBody", () => {
  it("掲載日とデッキリスト画像を取り出す", () => {
    const html = bodyHtml({
      eyecatch: "https://blog-imgs-166.fc2.com/d/e/n/deneblog1/2023062200542261f.jpg",
      decklist: DECKLIST,
      participants: "参加人数55人",
    });
    expect(parseRecipeBody(html)).toEqual({
      posted_date: "2026-07-13",
      decklist_image_url: DECKLIST,
      participants: 55,
    });
  });

  it("古い記事 (問い合わせ定型文が無い) でもデッキリスト画像を取れる", () => {
    // **本番の初回取込で実際に踏んだ回帰。** 定型文「…よりお問い合わせ下さい。」を
    // アンカーにしていたため、それが無い古い記事 41/117 件をまるごと落としていた。
    // 検証に使った実記事20件が全部最近のもので、古い定型文を1件も含んでいなかった
    // (サンプリングの偏り)。
    const html = bodyHtml({
      eyecatch: "https://blog-imgs-166.fc2.com/d/e/n/deneblog1/2023062200542261f.jpg",
      decklist: DECKLIST,
      era: "old",
    });
    expect(parseRecipeBody(html)?.decklist_image_url).toBe(DECKLIST);
  });

  it("アイキャッチが記事と同じ日にアップされていてもデッキリスト画像を選ぶ", () => {
    // **これが本命の回帰ガード。** 「ファイル名の日付 == 掲載日」で選ぶ規則は、
    // アイキャッチが同日アップの記事 (実測 22939 / 22925) で誤爆した。
    // 定型文より後ろの最初の画像、という構造で選ぶ。
    const html = bodyHtml({
      eyecatch: "https://blog-imgs-201.fc2.com/d/e/n/deneblog1/20260713150808fe7.jpg",
      decklist: DECKLIST,
    });
    expect(parseRecipeBody(html)?.decklist_image_url).toBe(DECKLIST);
  });

  it("参加人数が無ければ null (書いていないことは埋めない)", () => {
    // フィクスチャには実記事と同じ募集定型文「（参加人数6名以上ならOK）」が入っている。
    // これは**全記事に載っている**ので、「6名」を参加人数として拾うと全件が 6人参加になる。
    // 「N名」は拾わず「N人」だけを拾うことでかわしている。
    const html = bodyHtml({
      eyecatch: "https://blog-imgs-166.fc2.com/d/e/n/deneblog1/2023062200542261f.jpg",
      decklist: DECKLIST,
    });
    expect(parseRecipeBody(html)?.participants).toBeNull();
  });

  it("全角の参加人数も読む", () => {
    const html = bodyHtml({
      eyecatch: "https://blog-imgs-166.fc2.com/d/e/n/deneblog1/2023062200542261f.jpg",
      decklist: DECKLIST,
      participants: "参加人数５５人",
    });
    expect(parseRecipeBody(html)?.participants).toBe(55);
  });

  it("関連記事の画像を拾わない (本文の外は見ない)", () => {
    const html = bodyHtml({
      eyecatch: "https://blog-imgs-166.fc2.com/d/e/n/deneblog1/2023062200542261f.jpg",
      decklist: DECKLIST,
    }).replace(
      '<div class="relate_entry">関連記事</div>',
      '<a href="https://blog-imgs-201.fc2.com/d/e/n/deneblog1/20260713999999zzz.jpg">別記事</a>',
    );
    expect(parseRecipeBody(html)?.decklist_image_url).toBe(DECKLIST);
  });

  it("デッキリスト画像が無い記事は null (バナーで代用しない)", () => {
    const html = `<div class="ently_body"><div>2026.07.13 16:21</div>
      <div class="ently_text">
        ※もし1ヶ月以上掲載が行われていない場合は、メールフォームよりお問い合わせ下さい。<br>
        画像はありません
      </div><div class="fc2relate"></div></div>`;
    expect(parseRecipeBody(html)).toBeNull();
  });

  it("本文コンテナが無ければ null", () => {
    expect(parseRecipeBody("<html><body>まったく別のページ</body></html>")).toBeNull();
  });

  it("関連記事ブロック (fc2relate) が無ければ null (範囲を絞れないなら諦める)", () => {
    // fc2relate が無いときに「ページ末尾まで」で代用すると、サイドバーや関連ウィジェットの
    // blog-imgs サムネイルをこの記事のデッキリストとして拾いうる。
    // 誤ったレシピを見せるより載せないほうがよい。
    const html = bodyHtml({
      eyecatch: "https://blog-imgs-166.fc2.com/d/e/n/deneblog1/2023062200542261f.jpg",
      decklist: DECKLIST,
    }).replace('<div class="fc2relate"><div class="relate_entry">関連記事</div></div>', "");
    expect(parseRecipeBody(html)).toBeNull();
  });

  it("ヘッダに掲載日が無ければ null (コメント欄や最新記事の日時で代用しない)", () => {
    // 掲載日の探索をページ全体に広げると、記事ヘッダに日付が無いテンプレートで
    // コメント欄や「最新記事」ウィジェットの日時を掲載日として拾ってしまう。
    // 掲載日は新着順の並びと「掲載日」表示に使うので、間違えると**静かに**誤る。
    const html =
      bodyHtml({
        eyecatch: "https://blog-imgs-166.fc2.com/d/e/n/deneblog1/2023062200542261f.jpg",
        decklist: DECKLIST,
      }).replace('<div class="entry_date">2026.07.13 16:21</div>', "") +
      `<div class="comment_body">2011.01.01 09:00 コメント</div>`;
    expect(parseRecipeBody(html)).toBeNull();
  });

  it("class が複数指定でも本文を見つける", () => {
    // `class="ently_body clearfix"` のような複数クラスを素の文字列一致で見ると
    // 記事ごと取りこぼす (テンプレ変更で全件が静かに 0件になる)。
    const html = bodyHtml({
      eyecatch: "https://blog-imgs-166.fc2.com/d/e/n/deneblog1/2023062200542261f.jpg",
      decklist: DECKLIST,
    }).replace('class="ently_body"', 'class="ently_body clearfix"');
    expect(parseRecipeBody(html)?.decklist_image_url).toBe(DECKLIST);
  });
});

describe("parseRecipeEntryList", () => {
  it("カテゴリ一覧から記事 URL とタイトルを取り出す", () => {
    const html = `
      <a href="https://deneblog.jp/blog-entry-22941.html"><img src="thumb.jpg"></a>
      <a href="https://deneblog.jp/blog-entry-22941.html">【 #デュエマCS入賞デッキレシピ 】トレカラインCS優勝　サガループ　🍣mofura🍣さん</a>
      <a href="https://deneblog.jp/blog-entry-2.html">このブログについて</a>`;
    expect(parseRecipeEntryList(html)).toEqual([
      {
        url: "https://deneblog.jp/blog-entry-22941.html",
        title: "【 #デュエマCS入賞デッキレシピ 】トレカラインCS優勝　サガループ　🍣mofura🍣さん",
      },
      { url: "https://deneblog.jp/blog-entry-2.html", title: "このブログについて" },
    ]);
  });
});

describe("recipeCategoryPageUrls", () => {
  it("サフィックス無しのページを必ず先頭に含める", () => {
    // FC2 の「現在のページ」はサフィックス無し。-1 から始めると最新記事を取り逃す
    // (ingest-tournaments で実証済みの落とし穴)。
    expect(recipeCategoryPageUrls(2)).toEqual([
      "https://deneblog.jp/blog-category-72.html",
      "https://deneblog.jp/blog-category-72-1.html",
      "https://deneblog.jp/blog-category-72-2.html",
    ]);
  });
});

describe("exceedsSkipRate", () => {
  it("閾値未満なら false", () => {
    // 1/20 = 5%
    expect(exceedsSkipRate({ recipes: 19, skipped: 1 }, 0.1)).toBe(false);
  });

  it("ちょうど閾値なら false (超えたときだけ失敗)", () => {
    // 2/20 = 10%
    expect(exceedsSkipRate({ recipes: 18, skipped: 2 }, 0.1)).toBe(false);
  });

  it("閾値を超えたら true", () => {
    // 3/20 = 15%
    expect(exceedsSkipRate({ recipes: 17, skipped: 3 }, 0.1)).toBe(true);
  });

  it("#126 の取りこぼし (41/117) は既定の閾値で検知できる", () => {
    expect(exceedsSkipRate({ recipes: 76, skipped: 41 }, DEFAULT_MAX_SKIP_RATE)).toBe(true);
  });

  it("分母 0 (新着なし) は失敗扱いにしない", () => {
    expect(exceedsSkipRate({ recipes: 0, skipped: 0 }, 0.1)).toBe(false);
    expect(exceedsSkipRate({ recipes: 0, skipped: 0 }, 0)).toBe(false);
  });

  it("全件スキップは閾値 1 未満なら true", () => {
    expect(exceedsSkipRate({ recipes: 0, skipped: 5 }, 0.1)).toBe(true);
    expect(exceedsSkipRate({ recipes: 0, skipped: 5 }, 1)).toBe(false);
  });
});

describe("parseMaxSkipRate", () => {
  it("指定が無ければ既定値 0.1", () => {
    expect(DEFAULT_MAX_SKIP_RATE).toBe(0.1);
    expect(parseMaxSkipRate([])).toBe(0.1);
    expect(parseMaxSkipRate(["--pages=3"])).toBe(0.1);
  });

  it("--max-skip-rate= で上書きできる", () => {
    expect(parseMaxSkipRate(["--pages=3", "--max-skip-rate=0.25"])).toBe(0.25);
    expect(parseMaxSkipRate(["--max-skip-rate=0"])).toBe(0);
    expect(parseMaxSkipRate(["--max-skip-rate=1"])).toBe(1);
  });

  it("不正値 (数値でない・空・負・1 超) は既定値に戻す", () => {
    for (const bad of ["abc", "", "NaN", "-0.1", "1.5", "Infinity", "0.2x"]) {
      expect(parseMaxSkipRate([`--max-skip-rate=${bad}`])).toBe(DEFAULT_MAX_SKIP_RATE);
    }
  });
});
