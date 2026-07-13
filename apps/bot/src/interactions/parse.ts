/**
 * Discord の生ペイロードからサブコマンドとオプションを取り出す (純粋関数)。
 *
 * Workers では discord.js を使わないため、`interaction.options.getSubcommand()` に相当する
 * 処理を自前で書く。Discord は options を入れ子で送る:
 *   `/dm rule question:...`      → [{ name:"rule", type:1, options:[{name:"question", value:...}] }]
 *   `/dm deck rate list:...`     → [{ name:"deck", type:2, options:[{ name:"rate", type:1, ... }] }]
 */

/** Discord のオプション型。1=サブコマンド, 2=サブコマンドグループ。 */
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

export interface InteractionOption {
  name: string;
  type?: number;
  value?: unknown;
  options?: InteractionOption[];
}

export interface ParsedCommand {
  /** サブコマンドグループ (deck / meta / format)。トップレベルのサブコマンドなら undefined。 */
  group: string | undefined;
  /** サブコマンド (rule / rate / build / tier / chat ...)。 */
  sub: string;
  /** オプション名 → 値 (文字列)。 */
  options: Record<string, string>;
}

/** オプション配列を「名前 → 値」に畳む。サブコマンド/グループは値を持たないので除く。 */
function collectOptions(options: InteractionOption[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const opt of options ?? []) {
    if (opt.type === SUB_COMMAND || opt.type === SUB_COMMAND_GROUP) continue;
    if (opt.value !== undefined && opt.value !== null) out[opt.name] = String(opt.value);
  }
  return out;
}

/** 解釈できないペイロードは null を返す (握り潰して既定コマンドを走らせない)。 */
export function parseCommand(interaction: {
  data?: { name?: string; options?: InteractionOption[] };
}): ParsedCommand | null {
  const top = interaction.data?.options?.[0];
  if (!top) return null;

  if (top.type === SUB_COMMAND_GROUP) {
    const sub = top.options?.[0];
    if (!sub) return null;
    return { group: top.name, sub: sub.name, options: collectOptions(sub.options) };
  }

  return { group: undefined, sub: top.name, options: collectOptions(top.options) };
}
