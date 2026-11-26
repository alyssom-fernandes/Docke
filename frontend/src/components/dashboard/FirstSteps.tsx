import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, X, ChevronRight } from "lucide-react";
import api from "@/lib/api";

/**
 * Primeiros passos (B4.3.2): checklist de ativação no Início, com o progresso
 * tirado dos dados de verdade (pastas, documentos, equipe, obrigações), que
 * some sozinho quando tudo está feito e pode ser ocultado.
 */
export default function FirstSteps({ companyId, folders, documents, isAdmin }: {
  companyId: string; folders: number; documents: number; isAdmin: boolean;
}) {
  const chave = `docke_primeiros_passos_ocultos:${companyId}`;
  const [oculto, setOculto] = useState(() => localStorage.getItem(chave) === "1");
  const [membros, setMembros] = useState<number | null>(null);
  const [modelos, setModelos] = useState<number | null>(null);

  useEffect(() => {
    setOculto(localStorage.getItem(chave) === "1");
    if (!isAdmin) return;
    api.get(`/companies/${companyId}/members`).then((r) => setMembros(Array.isArray(r.data) ? r.data.length : 0)).catch(() => setMembros(null));
    api.get(`/companies/${companyId}/obligations/templates`).then((r) => setModelos(Array.isArray(r.data) ? r.data.length : 0)).catch(() => setModelos(null));
  }, [companyId, isAdmin, chave]);

  const passos = [
    { feito: folders > 0, texto: "Criar as pastas da empresa", to: "/documents?acao=nova-pasta" },
    { feito: documents > 0, texto: "Enviar os primeiros documentos", to: "/documents?acao=enviar" },
    ...(isAdmin ? [
      { feito: (membros ?? 0) > 1, texto: "Dar acesso à equipe", to: "/settings/users" },
      { feito: (modelos ?? 0) > 0, texto: "Cadastrar as obrigações com os modelos prontos", to: "/obligations" },
    ] : []),
  ];
  const feitos = passos.filter((p) => p.feito).length;
  if (oculto || feitos === passos.length || (isAdmin && (membros === null || modelos === null))) return null;

  return (
    <section aria-labelledby="primeiros-passos" className="reveal glass-panel glass-blur-card rounded-(--radius-panel) p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="primeiros-passos" className="text-mac-body font-semibold text-(--text-primary)">Primeiros passos</h2>
          <p className="text-mac-caption text-(--text-secondary)">{feitos} de {passos.length} feitos</p>
        </div>
        <button onClick={() => { localStorage.setItem(chave, "1"); setOculto(true); }} aria-label="Ocultar primeiros passos" title="Ocultar"
          className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)">
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2 h-1 rounded-full bg-(--bg-hover) overflow-hidden" aria-hidden="true">
        <div className="h-full bg-teal-600 transition-[width] duration-200" style={{ width: `${(feitos / passos.length) * 100}%` }} />
      </div>
      <ul className="mt-3 space-y-1">
        {passos.map((p) => (
          <li key={p.texto}>
            {p.feito ? (
              <span className="flex items-center gap-2 min-h-9 text-mac-body text-(--text-secondary) line-through decoration-(--text-tertiary)">
                <CheckCircle2 className="w-4 h-4 text-(--text-success) shrink-0" aria-hidden="true" />{p.texto}<span className="sr-only"> (feito)</span>
              </span>
            ) : (
              <Link to={p.to} className="group flex items-center gap-2 min-h-9 pointer-coarse:min-h-11 rounded-[6px] text-mac-body text-(--text-primary) hover:text-(--text-accent)">
                <Circle className="w-4 h-4 text-(--text-tertiary) shrink-0" aria-hidden="true" />{p.texto}
                <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-0 group-hover:opacity-100 transition-opacity duration-fast" aria-hidden="true" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
