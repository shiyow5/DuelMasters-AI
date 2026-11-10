import { describe, it, expect } from "vitest";
import {
  CARD_NAME_DASH_CHARS,
  CARD_NAME_STRIP_CHARS,
  CARD_NAME_TRANSLATE_FROM,
  CARD_NAME_TRANSLATE_TO,
  cardNameKey,
} from "../src/card-name.js";

/**
 * SQL 側の `lower(translate(normalize(x, NFKC), CARD_NAME_TRANSLATE_FROM, CARD_NAME_TRANSLATE_TO))` を
 * JS で再現する。Postgres の translate(x, from, to) は「from の i 文字目を to の i 文字目に置き換え、
 * to に対応する文字が無い from の文字は消す」。ここでは正規表現を使わず、**SQL に渡す文字列そのもの**
 * から表を作るので、TS 側の正規表現とは独立した実装になる。
 */
const sqlChars = new Set(CARD_NAME_STRIP_CHARS);
const fromChars = [...CARD_NAME_TRANSLATE_FROM];
const toChars = [...CARD_NAME_TRANSLATE_TO];
function sqlEquivalent(x: string): string {
  return [...x.normalize("NFKC")]
    .map((c) => {
      const i = fromChars.indexOf(c);
      if (i < 0) return c;
      return i < toChars.length ? toChars[i]! : "";
    })
    .join("")
    .toLowerCase();
}

/** 全コードポイント (サロゲート半分を除く) */
function* allCodePoints(): Generator<string> {
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    yield String.fromCodePoint(cp);
  }
}

describe("CARD_NAME_STRIP_CHARS: SQL translate と TS 正規化の文字集合の一致 (#167)", () => {
  it("SQL に渡す文字集合 == TS が消す文字集合 (全コードポイントで cardNameKey と SQL 相当が一致)", () => {
    const mismatches: string[] = [];
    for (const c of allCodePoints()) {
      // 単独の文字と、前後を普通の文字で挟んだ形の両方で比べる
      for (const s of [c, `あ${c}い`]) {
        if (cardNameKey(s) !== sqlEquivalent(s)) {
          mismatches.push(`U+${c.codePointAt(0)!.toString(16).padStart(4, "0")}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("TS が消す文字 (NFKC 後にキーから消える文字) はすべて SQL の translate 引数に入っている", () => {
    // 「cardNameKey で消える文字」を全コードポイントから逆算し、SQL の集合と突き合わせる。
    const removedByTs = new Set<string>();
    for (const c of allCodePoints()) {
      const n = c.normalize("NFKC");
      for (const d of n) if (cardNameKey(`あ${d}い`) === "あい") removedByTs.add(d);
    }
    // SQL も NFKC 後に translate するので、比べるのは「NFKC で変わらない文字」だけ。
    // (･ U+FF65 や 全角スペース U+3000 などは NFKC で ・ / 半角スペースに変わってから消える。
    //  集合には互換のため残しているが、translate に届く時点では現れない)
    const sqlAfterNfkc = [...sqlChars].filter((c) => c.normalize("NFKC") === c);
    expect([...removedByTs].sort()).toEqual(sqlAfterNfkc.sort());
  });

  it("従来 TS が落としていた \\s (JS の空白全般) はすべて含まれる", () => {
    const missing: string[] = [];
    for (const c of allCodePoints()) {
      if (/\s/u.test(c) && !sqlChars.has(c)) missing.push(c.codePointAt(0)!.toString(16));
    }
    expect(missing).toEqual([]);
  });

  it("旧 SQL の集合 (tools.ts / card.ts) と旧 TS の囲み記号はすべて含まれる (後退しない)", () => {
    for (const c of "・･ 　《》「」『』【】≪≫«»") expect(sqlChars.has(c)).toBe(true);
  });

  it("引用符 “ ” ‘ ’ と NFKC 後の \" ' を含む", () => {
    for (const c of "“”‘’\"'") expect(sqlChars.has(c)).toBe(true);
    // 全角の ＂ ＇ は NFKC で ASCII になってから消える
    expect(cardNameKey("＂轟轟轟＂ブランド")).toBe("轟轟轟ブランド");
  });

  it("重複がない (落とす文字と畳む文字も重ならない)", () => {
    expect(new Set(CARD_NAME_STRIP_CHARS).size).toBe([...CARD_NAME_STRIP_CHARS].length);
    expect(new Set(CARD_NAME_TRANSLATE_FROM).size).toBe(fromChars.length);
  });

  it("区切り / は消さない (ツインパクトの片面分割に使う)", () => {
    expect(cardNameKey("A ／ B")).toBe("a/b");
  });
});

describe("長音・ハイフン類のゆれ (#167 優先4)", () => {
  const dashes = ["ー", "ｰ", "-", "－", "‐", "‑", "‒", "–", "—", "―", "−", "﹣", "﹘"];

  it("どの長音・ハイフン・ダッシュ・マイナスでも同じキーになる", () => {
    for (const d of dashes) {
      expect(cardNameKey(`ヨミジ 丁${d}二式`)).toBe("ヨミジ丁ー二式");
      expect(cardNameKey(`ボルシャック・ドラゴン${d}`)).toBe(cardNameKey("ボルシャックドラゴンー"));
    }
    expect(cardNameKey("ＣＳ－２０")).toBe(cardNameKey("CS-20"));
  });

  it("落とさずに1文字へ畳む (長音の有無は別のキーのまま)", () => {
    expect(cardNameKey("ゲート")).not.toBe(cardNameKey("ゲト"));
    expect(cardNameKey("ゲ-ト")).toBe(cardNameKey("ゲート"));
  });

  it("TS で `ー` に畳まれる文字 == SQL で畳む文字 (全コードポイント、NFKC 後)", () => {
    const foldedByTs = new Set<string>();
    for (const c of allCodePoints()) {
      for (const d of c.normalize("NFKC")) {
        if (d !== "ー" && cardNameKey(`あ${d}い`) === "あーい") foldedByTs.add(d);
      }
    }
    const sqlAfterNfkc = [...CARD_NAME_DASH_CHARS].filter(
      (c) => c.normalize("NFKC") === c && c !== "ー",
    );
    expect([...foldedByTs].sort()).toEqual(sqlAfterNfkc.sort());
  });

  it("translate の to は畳む文字と同じ数の `ー` (残りの from は消える)", () => {
    expect(toChars).toEqual([...CARD_NAME_DASH_CHARS].map(() => "ー"));
  });

  it("波ダッシュ・チルダは畳まない (範囲外)", () => {
    expect(cardNameKey("あ〜い")).not.toBe("あーい");
    expect(cardNameKey("あ~い")).not.toBe("あーい");
  });
});
