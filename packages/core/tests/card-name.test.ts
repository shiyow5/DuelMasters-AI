import { describe, it, expect } from "vitest";
import { CARD_NAME_STRIP_CHARS, cardNameKey } from "../src/card-name.js";

/**
 * SQL 側の `lower(translate(normalize(x, NFKC), CARD_NAME_STRIP_CHARS, ''))` を JS で再現する。
 * translate(x, from, '') は「from に含まれる文字を消す」。ここでは正規表現を使わず、
 * **SQL に渡す文字列そのもの**を Set にして消すので、TS 側の正規表現とは独立した実装になる。
 */
const sqlChars = new Set(CARD_NAME_STRIP_CHARS);
function sqlEquivalent(x: string): string {
  return [...x.normalize("NFKC")]
    .filter((c) => !sqlChars.has(c))
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

  it("重複がない", () => {
    expect(new Set(CARD_NAME_STRIP_CHARS).size).toBe([...CARD_NAME_STRIP_CHARS].length);
  });

  it("区切り / は消さない (ツインパクトの片面分割に使う)", () => {
    expect(cardNameKey("A ／ B")).toBe("a/b");
  });
});
