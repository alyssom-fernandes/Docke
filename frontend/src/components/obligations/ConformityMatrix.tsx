import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";

interface Celula { instance_id: string; status: string; period_label: string; due_date: string; owner_name: string | null }
interface Matriz {
  empresas: { company_id: string; name: string; em_dia: number; total: number; atrasadas: number }[];
  obrigacoes: string[];
  celulas: Record<string, Record<string, Celula>>;
}

const ESTILO: Record<string, { rotulo: string; cls: string }> = {
  approved: { rotulo: "Em dia", cls: "bg-green-600/15 text-(--text-success)" },
  reviewing: { rotulo: "Em conferência", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  pending: { rotulo: "A fazer", cls: "bg-(--bg-hover) text-(--text-primary)" },
  at_risk: { rotulo: "Vence logo", cls: "bg-(--tint-warning) text-(--text-warning)" },
  overdue: { rotulo: "Atrasada", cls: "bg-(--tint-danger) text-(--text-danger)" },
  expired: { rotulo: "Vencida", cls: "bg-(--tint-danger) text-(--text-danger)" },
  blocked: { rotulo: "Travada", cls: "bg-(--tint-warning) text-(--text-warning)" },
  dispensado: { rotulo: "Dispensada", cls: "text-(--text-secondary)" },
  not_applicable: { rotulo: "Não se aplica", cls: "text-(--text-secondary)" },
};

/**
 * Conformidade do grupo (FA-A7-04): cada empresa numa linha, cada obrigação
 * numa coluna, com a situação da competência mais recente até o fim do mês.
 */
export default function ConformityMatrix() {
  const [m, setM] = useState<Matriz | null | "erro">(null);
  useEffect(() => { api.get<Matriz>("/obligations/matrix").then((r) => setM(r.data)).catch(() => setM("erro")); }, []);
  if (m === null) return <div className="h-48 rounded-(--radius-panel) bg-(--bg-hover) animate-pulse" aria-label="Carregando" />;
  if (m === "erro") return <p role="alert" className="text-mac-body text-(--text-danger)">Não foi possível montar a matriz agora.</p>;
  if (!m.obrigacoes.length) return <p className="text-mac-body text-(--text-secondary)">Nenhuma obrigação com competência até o fim deste mês nas empresas que você acessa.</p>;
  return (
    <div className="space-y-2">
      <p className="text-mac-caption text-(--text-secondary)">Situação da competência mais recente de cada obrigação, até o fim deste mês. Clique numa célula para abrir.</p>
      <div className="glass-panel glass-blur-card rounded-(--radius-panel) overflow-auto max-h-[70vh]">
        <table className="w-full border-separate border-spacing-0 text-mac-caption">
          <caption className="sr-only">Matriz de conformidade: empresas nas linhas, obrigações nas colunas</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-20 bg-(--bg-card) px-3 py-2 text-left font-semibold text-(--text-secondary) border-b border-(--border-default)">Empresa</th>
              {m.obrigacoes.map((o) => (
                <th key={o} scope="col" className="sticky top-0 z-10 bg-(--bg-card) px-2 py-2 text-left font-semibold text-(--text-secondary) border-b border-(--border-default) min-w-28 max-w-40">
                  <span className="line-clamp-2">{o}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.empresas.map((e) => (
              <tr key={e.company_id}>
                <th scope="row" className="sticky left-0 z-10 bg-(--bg-card) px-3 py-2 text-left font-medium text-(--text-primary) border-b border-(--border-default) min-w-40">
                  {e.name}
                  <span className={`block font-normal ${e.atrasadas ? "text-(--text-danger)" : "text-(--text-secondary)"}`}>
                    {e.em_dia} de {e.total} em dia{e.atrasadas ? ` · ${e.atrasadas} ${e.atrasadas === 1 ? "atrasada" : "atrasadas"}` : ""}
                  </span>
                </th>
                {m.obrigacoes.map((o) => {
                  const c = m.celulas[e.company_id]?.[o];
                  const st = c ? ESTILO[c.status] ?? { rotulo: c.status, cls: "" } : null;
                  return (
                    <td key={o} className="px-1.5 py-1.5 border-b border-(--border-default) align-top">
                      {c && st ? (
                        <Link to={`/obligations?instancia=${c.instance_id}`} title={`${o} · ${c.period_label} · vence ${new Date(c.due_date + "T12:00").toLocaleDateString("pt-BR")}${c.owner_name ? ` · ${c.owner_name}` : ""}`}
                          className={`block rounded-[6px] px-2 py-1 font-medium hover:ring-2 hover:ring-(--focus-ring) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${st.cls}`}>
                          {st.rotulo}
                          <span className="block font-normal opacity-80">{c.period_label}</span>
                        </Link>
                      ) : <span className="block px-2 py-1 text-(--text-tertiary)" aria-label="Não cadastrada">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
