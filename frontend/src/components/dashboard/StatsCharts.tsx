import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, ArrowUpRight, FolderOpen } from "lucide-react";

// Fase 3.2/3.4: dois widgets de gráfico do dashboard — juntos ocupam bem
// menos de 20% da tela (regra da pesquisa). Um hue só (teal, a cor da marca)
// porque as duas séries são de magnitude, não de identidade — não há
// categorias concorrendo por cor aqui, só grandeza variando por comprimento.

export interface DailyUpload {
  date: string;
  count: number;
}

export interface FolderBreakdown {
  id: string;
  name: string;
  document_count: number;
}

function fmtDayLabel(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

/** Linha fina de uploads por dia (14 dias) — traço 2px, extremidades
 * arredondadas, crosshair + tooltip no hover (a interação é o que torna um
 * SVG estático em "gráfico" de verdade, não decoração). */
export function UploadsLineChart({ data }: { data: DailyUpload[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (data.length === 0) return null;

  const W = 560;
  const H = 88;
  const padX = 8;
  const padY = 12;
  const max = Math.max(1, ...data.map((d) => d.count));
  const stepX = (W - padX * 2) / Math.max(1, data.length - 1);

  const points = data.map((d, i) => ({
    x: padX + i * stepX,
    y: H - padY - (d.count / max) * (H - padY * 2),
    ...d,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${H} L ${points[0].x} ${H} Z`;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let closest = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - relX);
      if (dist < bestDist) { bestDist = dist; closest = i; }
    });
    setHoverIdx(closest);
  }

  const hover = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[88px] overflow-visible"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label={`Documentos enviados por dia, últimos ${data.length} dias`}
      >
        <path d={areaPath} fill="var(--chart-teal-area, rgba(21,161,142,0.12))" stroke="none" />
        <path d={linePath} fill="none" stroke="#15A18E" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {hover && (
          <>
            <line x1={hover.x} y1={0} x2={hover.x} y2={H} stroke="var(--border-default)" strokeWidth={1} strokeDasharray="2,2" />
            <circle cx={hover.x} cy={hover.y} r={4} fill="#15A18E" stroke="var(--bg-card)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hover && (
        <div
          className="absolute -top-1 px-2 py-1 rounded-[6px] bg-[var(--text-primary)] text-[var(--bg-card)] text-mac-caption2 pointer-events-none whitespace-nowrap"
          style={{ left: `${(hover.x / W) * 100}%`, transform: "translate(-50%, -100%)" }}
        >
          {fmtDayLabel(hover.date)} · {hover.count} {hover.count === 1 ? "documento" : "documentos"}
        </div>
      )}
    </div>
  );
}

/** Barra horizontal — top pastas por nº de documentos. Fase 3.7: este é o
 * "filtro próprio do widget" — a linha inteira desce um nível na árvore
 * (drill-down dentro do próprio gráfico, via onDrill), independente do
 * filtro global de período que afeta o gráfico de uploads ao lado. O ícone
 * de seta externa é o atalho pra sair do widget e ver os documentos de
 * verdade, sem competir com o clique de drill-down na mesma área. Uma cor
 * só: o comprimento da barra é o dado, não a cor. */
export function FolderBarChart({ data, onDrill }: { data: FolderBreakdown[]; onDrill: (folderId: string, name: string) => void }) {
  const navigate = useNavigate();
  if (data.length === 0) return null;
  const max = Math.max(1, ...data.map((d) => d.document_count));

  return (
    <ul className="space-y-2">
      {data.map((f) => (
        <li key={f.id} className="flex items-center gap-1 group">
          <button
            onClick={() => onDrill(f.id, f.name)}
            className="flex-1 min-w-0 flex items-center gap-2 text-left"
            title={`Ver documentos por pasta dentro de "${f.name}"`}
          >
            <span className="w-20 flex-shrink-0 text-mac-caption text-[var(--text-secondary)] truncate group-hover:text-teal-500 transition-colors duration-fast">
              {f.name}
            </span>
            <span className="flex-1 h-4 bg-[var(--bg-hover)] rounded-[3px] overflow-hidden">
              <span
                className="block h-full bg-teal-500 rounded-[3px] transition-[width] duration-normal group-hover:bg-teal-400"
                style={{ width: `${Math.max(4, (f.document_count / max) * 100)}%` }}
              />
            </span>
            <span className="w-6 flex-shrink-0 text-mac-caption text-[var(--text-tertiary)] text-right tabular-nums">
              {f.document_count}
            </span>
            <ChevronRight className="w-3 h-3 text-[var(--text-tertiary)] flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-fast" />
          </button>
          <button
            onClick={() => navigate(`/documents?folder_id=${f.id}`)}
            title={`Abrir pasta "${f.name}" em Documentos`}
            aria-label={`Abrir pasta ${f.name} em Documentos`}
            className="flex-shrink-0 p-1 rounded-[4px] text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 hover:text-teal-500 hover:bg-[var(--bg-hover)] transition-colors duration-fast"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface FolderCrumb {
  id: string | null;
  name: string;
}

/** Breadcrumb do filtro próprio do widget "Documentos por pasta" — mesma
 * lógica de navegação hierárquica já usada em Documents.tsx, só que
 * isolada aqui dentro do card (não navega a página, só refiltra o gráfico). */
export function FolderChartBreadcrumb({ path, onNavigate }: { path: FolderCrumb[]; onNavigate: (index: number) => void }) {
  return (
    <div className="flex items-center gap-1 min-w-0 text-mac-caption text-[var(--text-tertiary)]">
      <FolderOpen className="w-3 h-3 flex-shrink-0" />
      {path.map((crumb, i) => (
        <span key={crumb.id ?? "root"} className="flex items-center gap-1 min-w-0">
          {i > 0 && <ChevronRight className="w-2.5 h-2.5 flex-shrink-0" />}
          <button
            onClick={() => onNavigate(i)}
            disabled={i === path.length - 1}
            className={`truncate transition-colors duration-fast ${
              i === path.length - 1 ? "text-[var(--text-secondary)] font-medium cursor-default" : "hover:text-teal-500"
            }`}
          >
            {crumb.name}
          </button>
        </span>
      ))}
    </div>
  );
}
