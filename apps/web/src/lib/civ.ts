/** 文明ごとの表示色 (Tailwind クラス) */
export const CIV_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  fire: {
    bg: "bg-dm-fire/20",
    text: "text-dm-fire",
    dot: "bg-dm-fire shadow-[0_0_8px_rgba(239,68,68,0.6)]",
  },
  water: {
    bg: "bg-dm-water/20",
    text: "text-dm-water",
    dot: "bg-dm-water shadow-[0_0_8px_rgba(59,130,246,0.6)]",
  },
  nature: {
    bg: "bg-dm-nature/20",
    text: "text-dm-nature",
    dot: "bg-dm-nature shadow-[0_0_8px_rgba(34,197,94,0.6)]",
  },
  light: {
    bg: "bg-dm-light/20",
    text: "text-dm-light",
    dot: "bg-dm-light shadow-[0_0_8px_rgba(250,204,21,0.6)]",
  },
  darkness: {
    bg: "bg-dm-darkness/20",
    text: "text-dm-darkness",
    dot: "bg-dm-darkness shadow-[0_0_8px_rgba(107,114,128,0.6)]",
  },
};

/** 文明の英語表示ラベル */
export const CIV_LABELS: Record<string, string> = {
  fire: "Fire",
  water: "Water",
  nature: "Nature",
  light: "Light",
  darkness: "Darkness",
};

/** 文明ごとの16進カラー (SVG 描画用。CIV_COLORS の dot と同色) */
export const CIV_HEX: Record<string, string> = {
  fire: "#ef4444",
  water: "#3b82f6",
  nature: "#22c55e",
  light: "#facc15",
  darkness: "#6b7280",
};
