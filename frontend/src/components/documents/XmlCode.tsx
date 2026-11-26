import { Fragment, useMemo, type ReactNode } from "react";

/**
 * XML legível (A5-54): recuo pela profundidade das tags (a NF-e costuma vir
 * numa linha só), números de linha e cores para tag, atributo e valor. Usa
 * só tokens do tema; nada é executado nem interpretado como HTML.
 */
export function prettyXml(src: string): string {
  // Refaz o recuo sempre que há tags: a NF-e vem em uma linha ou com várias tags por linha.
  if (!/>\s*</.test(src) || src.length > 400_000) return src;
  const parts = src.replace(/>\s*</g, ">\n<").split("\n");
  let depth = 0;
  const out: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const closing = /^<\//.test(p);
    const selfClosing = /\/>$/.test(p) || /^<\?/.test(p) || /^<!/.test(p);
    const opensAndCloses = /^<[^/!?][^>]*>.*<\/[^>]+>$/.test(p);
    if (closing) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + p);
    if (!closing && !selfClosing && !opensAndCloses && /^<[^/]/.test(p)) depth++;
  }
  return out.join("\n");
}

function highlightLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(<\/?[\w:.-]+)|([\w:.-]+)(=)("[^"]*")|(\/?>)|(<\?[^?]*\?>)|(<!--.*?-->)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(<span key={i++}>{line.slice(last, m.index)}</span>);
    if (m[1]) out.push(<span key={i++} className="text-teal-700 dark:text-teal-300">{m[1]}</span>);
    else if (m[2]) out.push(
      <Fragment key={i++}>
        <span className="text-violet-700 dark:text-violet-300">{m[2]}</span>
        <span className="text-(--text-secondary)">{m[3]}</span>
        <span className="text-amber-800 dark:text-amber-300">{m[4]}</span>
      </Fragment>,
    );
    else if (m[5]) out.push(<span key={i++} className="text-teal-700 dark:text-teal-300">{m[5]}</span>);
    else out.push(<span key={i++} className="text-(--text-secondary)">{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(<span key={i++}>{line.slice(last)}</span>);
  return out;
}

export default function XmlCode({ text }: { text: string }) {
  const lines = useMemo(() => prettyXml(text).split("\n"), [text]);
  const width = String(lines.length).length;
  return (
    <div className="py-4 text-[12px] leading-relaxed font-mono text-(--text-primary) select-text" role="region" aria-label="Conteúdo do XML">
      {lines.map((l, n) => (
        <div key={n} className="flex hover:bg-(--bg-hover)">
          <span aria-hidden="true" className="select-none shrink-0 pr-3 pl-4 text-right text-(--text-secondary) tabular-nums" style={{ width: `${width + 3}ch` }}>{n + 1}</span>
          <span className="flex-1 pr-4 whitespace-pre-wrap break-all">{highlightLine(l)}</span>
        </div>
      ))}
    </div>
  );
}
