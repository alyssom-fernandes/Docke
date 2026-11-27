import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronRight, Loader2 } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { getFileStyle } from "@/lib/fileType";

interface Hit { id: string; name: string; folder_id: string | null; folder_path_label?: string | null }
interface Grupo { companyId: string; companyName: string; total: number; results: Hit[] }

/**
 * Busca em todas as empresas de uma vez (B2.1.7): a mesma consulta em cada
 * empresa que a pessoa acessa (além da atual), os 5 primeiros de cada uma.
 * Abrir um resultado troca a empresa e leva ao documento. Só roda quando a
 * pessoa pede, para não disparar uma consulta por empresa a cada letra.
 */
export default function OtherCompaniesResults({ q }: { q: string }) {
  const { current, companies, setCurrent } = useCompany();
  const navigate = useNavigate();
  const outras = (companies ?? []).filter((c) => c.id !== current?.id);
  const [ligado, setLigado] = useState(false);
  const [grupos, setGrupos] = useState<Grupo[] | null>(null);

  useEffect(() => { setGrupos(null); }, [q, current?.id]);
  useEffect(() => {
    if (!ligado || !q.trim() || !outras.length) return;
    let vivo = true;
    setGrupos(null);
    Promise.allSettled(outras.map((c) =>
      api.get<{ total: number; results: Hit[] }>("/search", { params: { q, company_id: c.id, page_size: 5 } })
        .then((r) => ({ companyId: c.id, companyName: c.name, total: r.data.total, results: r.data.results })),
    )).then((rs) => {
      if (!vivo) return;
      setGrupos(rs.flatMap((r) => (r.status === "fulfilled" && r.value.total > 0 ? [r.value] : [])).sort((a, b) => b.total - a.total));
    });
    return () => { vivo = false; };
  }, [ligado, q, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!outras.length || !q.trim()) return null;
  if (!ligado) {
    return (
      <button type="button" onClick={() => setLigado(true)}
        className="inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 text-mac-caption font-medium text-(--text-accent) hover:underline">
        <Building2 className="w-3.5 h-3.5" aria-hidden="true" /> Buscar também nas outras {outras.length} {outras.length === 1 ? "empresa" : "empresas"}
      </button>
    );
  }
  function abrir(g: Grupo, h?: Hit) {
    const c = outras.find((x) => x.id === g.companyId);
    if (!c) return;
    setCurrent(c);
    navigate(h ? `/documents?folder_id=${h.folder_id ?? ""}&doc=${h.id}&busca=${encodeURIComponent(q)}` : `/search?q=${encodeURIComponent(q)}`);
  }
  return (
    <section aria-label="Resultados nas outras empresas" className="space-y-2">
      <h2 className="text-[11px] font-bold text-(--text-secondary)">Nas outras empresas</h2>
      {grupos === null ? (
        <p role="status" className="flex items-center gap-2 text-mac-caption text-(--text-secondary)"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Buscando em {outras.length} {outras.length === 1 ? "empresa" : "empresas"}…</p>
      ) : grupos.length === 0 ? (
        <p className="text-mac-caption text-(--text-secondary)">Nada com “{q}” nas outras empresas.</p>
      ) : grupos.map((g) => (
        <div key={g.companyId} className="glass-panel glass-blur-card rounded-(--radius-panel) overflow-hidden">
          <button type="button" onClick={() => abrir(g)} className="w-full flex items-center gap-2 px-4 py-2 border-b border-(--border-default) text-left text-mac-caption font-semibold text-(--text-primary) hover:bg-(--bg-hover)">
            <Building2 className="w-3.5 h-3.5 text-(--text-accent)" aria-hidden="true" />
            <span className="flex-1 truncate">{g.companyName}</span>
            <span className="font-normal text-(--text-secondary)">{g.total} {g.total === 1 ? "resultado" : "resultados"}{g.total > g.results.length ? " · ver todos" : ""}</span>
            <ChevronRight className="w-3.5 h-3.5 text-(--text-secondary)" aria-hidden="true" />
          </button>
          <ul>
            {g.results.map((h) => {
              const Icon = getFileStyle(h.name).icon;
              return (
                <li key={h.id} className="border-b border-(--border-default) last:border-0">
                  <button type="button" onClick={() => abrir(g, h)} className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-(--bg-hover)">
                    <Icon className="w-6 h-6 shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-mac-body text-(--text-primary) truncate">{h.name}</span>
                      {h.folder_path_label && <span className="block text-mac-caption text-(--text-secondary) truncate">{h.folder_path_label}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
