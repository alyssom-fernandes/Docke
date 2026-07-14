interface Props {
  name: string;
  maxWidth?: string;
  className?: string;
  /** Linha selecionada (fill sólido) — a extensão usa branco/70 em vez do
   * tertiary token, que fica ilegível sobre um fundo teal saturado. */
  inverted?: boolean;
}

/**
 * Shows a filename truncated in the middle so the extension is always visible.
 * e.g. "NFe_Posto_Central_Final_V2.pdf" → "NFe_Posto_Ce…Final_V2.pdf"
 */
export default function TruncatedFileName({ name, maxWidth = "300px", className = "", inverted = false }: Props) {
  const dotIdx = name.lastIndexOf(".");
  const hasExt = dotIdx > 0 && dotIdx < name.length - 1;
  const base = hasExt ? name.slice(0, dotIdx) : name;
  const ext = hasExt ? name.slice(dotIdx) : "";

  return (
    <span
      className={`inline-flex min-w-0 ${className}`}
      style={{ maxWidth }}
      title={name}
    >
      <span className="truncate">{base}</span>
      {ext && <span className={`flex-shrink-0 ${inverted ? "text-white/70" : "text-[var(--text-tertiary)]"}`}>{ext}</span>}
    </span>
  );
}
