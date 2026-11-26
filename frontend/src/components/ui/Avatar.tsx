interface AvatarProps {
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg";
}

const initials = (name: string) =>
  (name ?? "?").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

// Cor estável por pessoa (A2-41): a mesma pessoa tem sempre a mesma cor, e
// iniciais iguais ficam distinguíveis numa lista. Tons -700 dão 4,5:1 com branco.
const PALETTE = ["bg-teal-700", "bg-indigo-700", "bg-rose-700", "bg-amber-700", "bg-violet-700", "bg-sky-700", "bg-emerald-700", "bg-fuchsia-700"];

function colorFor(name: string) {
  let h = 0;
  for (const ch of name ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export default function Avatar({ name, src, size = "md" }: AvatarProps) {
  const sz = size === "sm" ? "w-7 h-7 text-mac-caption" : size === "lg" ? "w-14 h-14 text-mac-title3" : "w-8 h-8 text-mac-body";
  return (
    <div
      className={`${sz} rounded-full flex items-center justify-center font-semibold shrink-0 overflow-hidden ${src ? "bg-(--bg-hover)" : `${colorFor(name)} text-white`}`}
      role="img"
      aria-label={name}
    >
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <span aria-hidden="true">{initials(name)}</span>}
    </div>
  );
}
