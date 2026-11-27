import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, ArrowUpRight, FolderOpen } from "lucide-react";

// Fase 3.2/3.4: dois widgets de gráfico do Início. Um hue só (a cor da
// marca, por token) porque as duas séries são de grandeza, não de identidade.

export interface DailyUpload {
  date: string;
  count: number;
}

export interface FolderBreakdown {
  id: string | null;
  name: string;
  document_count: number;
  has_children?: boolean;
  /** "outras" = pastas agrupadas além das 6 maiores; "direto" = arquivos soltos na pasta atual. */
  kind?: "outras" | "direto";
}

function fmtDayLabel(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");
}

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;

/**
 * Envios por dia em colunas (J1-07): contagem de cada dia é um número inteiro,
 * então cada dia é uma coluna (a linha ligando os pontos sugeria um contínuo
 * que não existe). Dia sem envio tem uma marca baixa para o dia aparecer; o
 * dia de hoje fica destacado. Preenche a largura do cartão (A3-17); a coluna
 * em foco responde ao mouse, ao toque e às setas (A3-19), e uma tabela oculta
 * entrega os números a leitores de tela.
 */
export function UploadsLineChart({ data }: { data: DailyUpload[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const navigate = useNavigate();
  // Cada coluna abre os documentos enviados naquele dia (B4.1.2): nenhum número é beco sem saída.
  const abrirDia = (iso: string) => navigate(`/search?periodo=custom&de=${iso}&ate=${iso}&ordem=recentes`);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (data.length === 0) return null;

  const W = width;
  const H = 112;
  const padTop = 18;
  const padBottom = 1;
  const max = Math.max(1, ...data.map((d) => d.count));
  const slot = W / data.length;
  const barW = Math.max(2, Math.min(28, slot * 0.68));
  const todayIso = new Date().toLocaleDateString("sv-SE"); // AAAA-MM-DD no fuso local
  const points = data.map((d, i) => {
    const h = d.count > 0 ? Math.max(3, (d.count / max) * (H - padTop - padBottom)) : 2;
    return { x: slot * i + slot / 2, y: H - padBottom - h, h, today: d.date === todayIso, ...d };
  });
  const peak = data.reduce((a, b) => (b.count > a.count ? b : a), data[0]);
  const hover = hoverIdx !== null ? points[hoverIdx] : null;
  // Rótulo direto em cima da coluna quando cabe (estética P3): sem precisar pairar.
  const rotulos = slot >= 18;
  // Coluna com só os cantos de cima arredondados: a base fica reta na linha do eixo.
  const coluna = (x: number, y: number, w: number, h: number) => {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  };
  const ticks = [0, Math.floor((data.length - 1) / 2), data.length - 1];

  function pick(clientX: number, rect: DOMRect) {
    const relX = ((clientX - rect.left) / rect.width) * W;
    setHoverIdx(Math.min(points.length - 1, Math.max(0, Math.floor(relX / slot))));
  }

  return (
    <div>
      <div
        ref={boxRef}
        className="relative outline-hidden rounded-(--radius-control) focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
        tabIndex={0}
        role="group"
        aria-label={`Envios por dia. Use as setas para ver cada dia e Enter para abrir os documentos dele. Pico de ${plural(peak.count, "documento", "documentos")} em ${fmtDayLabel(peak.date)}.`}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); setHoverIdx((i) => Math.min(points.length - 1, (i ?? -1) + 1)); }
          if (e.key === "ArrowLeft") { e.preventDefault(); setHoverIdx((i) => Math.max(0, (i ?? points.length) - 1)); }
          if (e.key === "Home") { e.preventDefault(); setHoverIdx(0); }
          if (e.key === "End") { e.preventDefault(); setHoverIdx(points.length - 1); }
          if (e.key === "Escape") setHoverIdx(null);
          if (e.key === "Enter" && hoverIdx !== null && points[hoverIdx].count > 0) { e.preventDefault(); abrirDia(points[hoverIdx].date); }
        }}
        onBlur={() => setHoverIdx(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          className="block overflow-visible touch-pan-y"
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={(e) => { if (e.pointerType === "mouse") setHoverIdx(null); }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const i = Math.min(points.length - 1, Math.max(0, Math.floor((((e.clientX - rect.left) / rect.width) * W) / slot)));
            if (points[i].count > 0) abrirDia(points[i].date);
          }}
          style={{ cursor: "pointer" }}
          aria-hidden="true"
        >
          <line x1={0} x2={W} y1={padTop} y2={padTop} stroke="var(--border-default)" strokeDasharray="2,3" />
          {points.map((p, i) => (
            <g key={p.date} opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.45} className="transition-opacity duration-fast">
              <path
                d={coluna(p.x - barW / 2, p.y, barW, p.h)}
                fill={p.count === 0 ? "var(--border-control)" : "var(--chart-line)"}
                fillOpacity={p.count === 0 || p.count === peak.count ? 1 : 0.72}
                className="chart-grow-y"
                style={{ animationDelay: `${Math.min(i, 30) * 16}ms` }}
              />
              {rotulos && p.count > 0 && (
                <text x={p.x} y={p.y - 4} textAnchor="middle" fontSize="10.5" fontWeight={p.count === peak.count ? 600 : 500}
                  fill={p.count === peak.count ? "var(--text-primary)" : "var(--text-secondary)"} className="tabular-nums chart-fade"
                  style={{ animationDelay: `${180 + Math.min(i, 30) * 16}ms` }}>
                  {p.count.toLocaleString("pt-BR")}
                </text>
              )}
              {p.today && <circle cx={p.x} cy={H + 5} r={2} fill="var(--text-accent)" />}
            </g>
          ))}
          <line x1={0} x2={W} y1={H - padBottom} y2={H - padBottom} stroke="var(--border-default)" />
        </svg>
        {!rotulos && (
          <span className="absolute left-0 top-0 -translate-y-1/2 text-mac-caption2 text-(--text-secondary) tabular-nums bg-(--bg-card) pr-1" style={{ top: padTop }}>
            {max.toLocaleString("pt-BR")}
          </span>
        )}
        {hover && (
          <div
            className="absolute top-0 px-2 py-1 rounded-(--radius-control) bg-(--text-primary) text-(--bg-card) text-mac-caption pointer-events-none whitespace-nowrap"
            style={{
              left: `${(hover.x / W) * 100}%`,
              transform: `translate(${hover.x < W * 0.15 ? "0" : hover.x > W * 0.85 ? "-100%" : "-50%"}, -110%)`,
            }}
            role="status"
          >
            {hover.today ? "Hoje" : fmtDayLabel(hover.date)} · {plural(hover.count, "documento", "documentos")}{hover.count > 0 ? " · clique para ver" : ""}
          </div>
        )}
      </div>
      <div className="relative h-5 mt-2.5 text-mac-caption2 text-(--text-secondary) tabular-nums" aria-hidden="true">
        {ticks.map((i, k) => (
          <span
            key={k}
            className="absolute top-0 whitespace-nowrap"
            style={{ left: `${(points[i].x / W) * 100}%`, transform: k === 0 ? "none" : k === 2 ? "translateX(-100%)" : "translateX(-50%)" }}
          >
            {points[i].today ? "hoje" : fmtDayLabel(data[i].date)}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Documentos enviados por dia</caption>
        <thead><tr><th scope="col">Dia</th><th scope="col">Documentos</th></tr></thead>
        <tbody>
          {data.map((d) => <tr key={d.date}><td>{fmtDayLabel(d.date)}</td><td>{d.count}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Pastas com mais documentos, somando as subpastas (achado A3-20). A linha
 * desce um nível quando a pasta tem subpastas; o atalho ao lado abre a pasta
 * em Documentos e fica visível no foco e no toque, não só no hover (A3-19).
 */
export function FolderBarChart({ data, onDrill }: { data: FolderBreakdown[]; onDrill: (folderId: string, name: string) => void }) {
  const navigate = useNavigate();
  if (data.length === 0) return null;
  const max = Math.max(1, ...data.map((d) => d.document_count));

  return (
    <ul className="space-y-1">
      {data.map((f, i) => {
        const bar = (
          <>
            <span className="w-28 sm:w-32 shrink-0 text-mac-caption text-(--text-secondary) truncate group-hover:text-(--text-primary)" title={f.name}>
              {f.name}
            </span>
            <span className="flex-1 h-3 bg-(--chart-track) rounded-full overflow-hidden">
              <span
                className={`block h-full rounded-full transition-[width] duration-normal chart-grow-x ${f.kind ? "bg-(--chart-bar)/55" : "bg-(--chart-bar) group-hover:bg-(--chart-bar-hover)"}`}
                style={{ width: `${Math.max(3, (f.document_count / max) * 100)}%`, animationDelay: `${Math.min(i, 12) * 40}ms` }}
              />
            </span>
            <span className={`w-10 shrink-0 text-mac-caption text-right tabular-nums ${f.document_count === max ? "font-semibold text-(--text-primary)" : "text-(--text-secondary)"}`}>
              {f.document_count.toLocaleString("pt-BR")}
            </span>
          </>
        );
        if (f.kind === "outras" || !f.id) {
          return (
            <li key={`outras-${f.name}`} className="flex items-center gap-2 min-h-8 pr-8">
              {bar}
            </li>
          );
        }
        const id = f.id;
        const drill = f.has_children && f.kind !== "direto";
        return (
          <li key={`${id}-${f.kind ?? ""}`} className="group flex items-center gap-1">
            <button
              onClick={() => (drill ? onDrill(id, f.name) : navigate(`/documents?folder_id=${id}`))}
              className="flex-1 min-w-0 flex items-center gap-2 min-h-8 pointer-coarse:min-h-11 rounded-(--radius-control) text-left focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
              aria-label={`${f.name}: ${plural(f.document_count, "documento", "documentos")}. ${drill ? "Ver subpastas" : "Abrir em Documentos"}`}
            >
              {bar}
              <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${drill ? "text-(--text-secondary)" : "invisible"}`} aria-hidden="true" />
            </button>
            <button
              onClick={() => navigate(`/documents?folder_id=${id}`)}
              title={`Abrir "${f.name}" em Documentos`}
              aria-label={`Abrir ${f.name} em Documentos`}
              className={`shrink-0 p-1 pointer-coarse:p-2.5 rounded-badge text-(--text-secondary) hover:text-(--text-accent) hover:bg-(--bg-hover)
                opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100
                focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${drill ? "" : "invisible"}`}
              tabIndex={drill ? 0 : -1}
            >
              <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface FolderCrumb {
  id: string | null;
  name: string;
}

/** Caminho dentro do gráfico de pastas: só refiltra o gráfico, não navega. */
export function FolderChartBreadcrumb({ path, onNavigate }: { path: FolderCrumb[]; onNavigate: (index: number) => void }) {
  return (
    <nav aria-label="Caminho no gráfico de pastas" className="flex items-center gap-1 min-w-0 text-mac-caption text-(--text-secondary)">
      <FolderOpen className="w-3 h-3 shrink-0" aria-hidden="true" />
      {path.map((crumb, i) => (
        <span key={crumb.id ?? "root"} className="flex items-center gap-1 min-w-0">
          {i > 0 && <ChevronRight className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />}
          {i === path.length - 1 ? (
            <span className="truncate text-(--text-primary) font-medium" aria-current="location">{crumb.name}</span>
          ) : (
            <button onClick={() => onNavigate(i)} className="truncate hover:text-(--text-accent) underline-offset-2 hover:underline">
              {crumb.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
