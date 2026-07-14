interface AvatarProps {
  name: string;
  src?: string;
  size?: "sm" | "md";
}

const initials = (name: string) =>
  (name ?? "?").split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();

export default function Avatar({ name, src, size = "md" }: AvatarProps) {
  const sz = size === "sm" ? "w-7 h-7 text-mac-caption" : "w-8 h-8 text-mac-body";
  return (
    <div
      className={`${sz} rounded-full flex items-center justify-center font-semibold shrink-0 overflow-hidden bg-[var(--bg-hover)] text-[var(--text-secondary)] border border-[var(--border-default)]`}
      aria-label={name}
    >
      {src ? <img src={src} alt={name} className="w-full h-full object-cover" /> : initials(name)}
    </div>
  );
}
