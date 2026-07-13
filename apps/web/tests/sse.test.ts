import { describe, it, expect } from "vitest";
import { createSseParser } from "../src/lib/sse.js";

/** パーサに chunk を順に流し、拾えたイベントを返す */
function parse(chunks: string[]): Array<[string, string]> {
  const events: Array<[string, string]> = [];
  const parser = createSseParser((event, data) => events.push([event, data]));
  for (const c of chunks) parser.push(c);
  parser.end();
  return events;
}

describe("createSseParser", () => {
  it("event と data の組を1フレームとして取り出す", () => {
    expect(parse(['event: token\ndata: {"text":"あ"}\n\n'])).toEqual([["token", '{"text":"あ"}']]);
  });

  it("連続するフレームを分ける", () => {
    const events = parse([
      'event: tool\ndata: {"name":"search_rules"}\n\n',
      'event: token\ndata: {"text":"結論"}\n\n',
      'event: done\ndata: {"result":{"response":"..."}}\n\n',
    ]);
    expect(events.map((e) => e[0])).toEqual(["tool", "token", "done"]);
  });

  it("行の途中で切れたチャンクをつなぐ", () => {
    // ネットワークのチャンク境界はフレーム境界と一致しない。ここを間違えると回答が壊れる。
    const events = parse(["event: tok", 'en\ndata: {"te', 'xt":"あい"}', "\n\n"]);
    expect(events).toEqual([["token", '{"text":"あい"}']]);
  });

  it("1チャンクに複数フレームが入っていても分ける", () => {
    const events = parse([
      'event: token\ndata: {"text":"あ"}\n\nevent: token\ndata: {"text":"い"}\n\n',
    ]);
    expect(events).toEqual([
      ["token", '{"text":"あ"}'],
      ["token", '{"text":"い"}'],
    ]);
  });

  it("data が複数行に分かれていたら改行で連結する", () => {
    expect(parse(["event: token\ndata: 1行目\ndata: 2行目\n\n"])).toEqual([
      ["token", "1行目\n2行目"],
    ]);
  });

  it("CRLF を扱える", () => {
    expect(parse(['event: token\r\ndata: {"text":"あ"}\r\n\r\n'])).toEqual([
      ["token", '{"text":"あ"}'],
    ]);
  });

  it("末尾の改行が無いフレームも end() で取りこぼさない", () => {
    expect(parse(['event: done\ndata: {"result":{}}'])).toEqual([["done", '{"result":{}}']]);
  });

  it("id / retry / コメント行は無視する", () => {
    expect(parse([": keep-alive\nid: 1\nretry: 3000\nevent: token\ndata: x\n\n"])).toEqual([
      ["token", "x"],
    ]);
  });

  it("data が無いフレームは通知しない", () => {
    expect(parse(["event: token\n\n"])).toEqual([]);
  });

  it("data の先頭スペースは1つだけ剥がす (本文のスペースは残す)", () => {
    expect(parse(["event: token\ndata:  先頭に空白\n\n"])).toEqual([["token", " 先頭に空白"]]);
  });
});
