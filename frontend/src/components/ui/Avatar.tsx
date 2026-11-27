interface AvatarProps {
  name: string;
  src?: string;
  size?: "xs" | "sm" | "md" | "lg";
}

const initials = (name: string) =>
  (name ?? "?").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

// Monograma como nos Contatos e no Mensagens do macOS: círculo em degradê
// cinza com as iniciais em branco (sem foto).
const MONOGRAM = "bg-[linear-gradient(180deg,#A3A3A8_0%,#7C7C82_100%)] text-white";

export default function Avatar({ name, src, size = "md" }: AvatarProps) {
  const sz = size === "xs" ? "w-[22px] h-[22px] text-[9px]" : size === "sm" ? "w-7 h-7 text-mac-caption" : size === "lg" ? "w-14 h-14 text-mac-title3" : "w-8 h-8 text-mac-body";
  return (
    <div
      className={`${sz} rounded-full flex items-center justify-center font-semibold tracking-[0.02em] shrink-0 overflow-hidden ${src ? "bg-(--bg-hover)" : MONOGRAM}`}
      role="img"
      aria-label={name}
    >
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <span aria-hidden="true">{initials(name)}</span>}
    </div>
  );
}
