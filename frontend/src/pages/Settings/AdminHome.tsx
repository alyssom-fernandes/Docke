import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Users as UsersIcon, Tags, Archive, ChevronRight, AlertTriangle, CheckCircle2 } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";

type Count = number | null | "erro";

interface Attention { key: string; text: string; to: string }

/**
 * Administração (A9-01..A9-04): primeiro o que precisa de atenção (pessoas
 * com senha provisória ou desativadas, documentos esperando conferência,
 * fila de descarte, texto não lido); depois os atalhos com números reais.
 * Contagem que falha mostra "—" e um aviso, não um brilho girando.
 */
export default function AdminHome() {
  usePageTitle("Administração");
  const { current, companies } = useCompany();
  const [people, setPeople] = useState<Count>(null);
  const [fields, setFields] = useState<Count>(null);
  const [policies, setPolicies] = useState<Count>(null);
  const [attention, setAttention] = useState<Attention[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!current) return;
    setFailed(false);
    const items: Attention[] = [];
    const jobs: Promise<unknown>[] = [
      api.get<{ is_active: boolean; must_change_password: boolean }[]>(`/companies/${current.id}/people`).then((r) => {
        setPeople(r.data.filter((p) => p.is_active).length);
        const prov = r.data.filter((p) => p.is_active && p.must_change_password).length;
        if (prov) items.push({ key: "prov", text: `${prov} ${prov === 1 ? "pessoa ainda não trocou" : "pessoas ainda não trocaram"} a senha provisória`, to: "/settings/users" });
      }).catch(() => { setPeople("erro"); setFailed(true); }),
      api.get<unknown[]>("/custom-fields", { params: { company_id: current.id } }).then((r) => setFields(r.data.length)).catch(() => { setFields("erro"); setFailed(true); }),
      api.get<unknown[]>(`/companies/${current.id}/retention/policies`).then((r) => setPolicies(r.data.length)).catch(() => { setPolicies("erro"); setFailed(true); }),
      api.get<{ fila: number; aprovados: number; bloqueios: number; documentos: number; cobertos: number }>(`/companies/${current.id}/retention/summary`).then((r) => {
        if (r.data.fila) items.push({ key: "fila", text: `${r.data.fila} ${r.data.fila === 1 ? "documento com prazo de guarda vencido espera" : "documentos com prazo de guarda vencido esperam"} decisão`, to: "/settings/retention?aba=fila" });
        const sem = r.data.documentos - r.data.cobertos;
        if (sem > 0) items.push({ key: "cob", text: `${sem} ${sem === 1 ? "documento está" : "documentos estão"} sem prazo de guarda`, to: "/settings/retention?aba=onde" });
      }).catch(() => setFailed(true)),
      api.get<{ resumo: { obrigacoes_conferir: number; texto_com_falha: number } }>(`/today/company/${current.id}`).then((r) => {
        if (r.data.resumo.obrigacoes_conferir) items.push({ key: "conf", text: `${r.data.resumo.obrigacoes_conferir} ${r.data.resumo.obrigacoes_conferir === 1 ? "documento espera" : "documentos esperam"} conferência em obrigações`, to: "/obligations?status=reviewing" });
        if (r.data.resumo.texto_com_falha) items.push({ key: "ocr", text: `${r.data.resumo.texto_com_falha} ${r.data.resumo.texto_com_falha === 1 ? "documento sem texto lido" : "documentos sem texto lido"}`, to: "/settings/organization" });
      }).catch(() => setFailed(true)),
    ];
    Promise.allSettled(jobs).then(() => setAttention(items));
  }, [current?.id]);

  const fmt = (c: Count, um: string, varios: string) => (c === null ? "…" : c === "erro" ? "—" : `${c} ${c === 1 ? um : varios}`);
  const cards = [
    { to: "/settings/organization", icon: Building2, color: "bg-slate-500", title: "Organização", description: "Empresas, CNPJ, logo, perfil fiscal e exportação dos dados.", stat: `${companies.length} ${companies.length === 1 ? "empresa" : "empresas"}` },
    { to: "/settings/users", icon: UsersIcon, color: "bg-indigo-500", title: "Pessoas e acessos", description: "Quem entra, com que papel e onde; grupos.", stat: fmt(people, "pessoa ativa", "pessoas ativas") },
    { to: "/settings/metadata", icon: Tags, color: "bg-orange-500", title: "Metadados", description: "Campos que os documentos preenchem, por pasta.", stat: fmt(fields, "campo", "campos") },
    { to: "/settings/retention", icon: Archive, color: "bg-amber-600", title: "Retenção e descarte", description: "Prazos de guarda, bloqueio judicial e fila de descarte.", stat: fmt(policies, "prazo", "prazos") },
  ];

  return (
    <div className="space-y-5">
      <section aria-labelledby="adm-atencao" className="glass-panel glass-blur-card rounded-(--radius-panel) p-4 sm:p-5 space-y-2">
        <h2 id="adm-atencao" className="text-mac-body font-semibold text-(--text-primary)">Precisa de atenção em {current?.name ?? "…"}</h2>
        {!attention ? <div className="h-12 rounded bg-(--bg-hover) animate-pulse" aria-label="Carregando" /> : attention.length === 0 ? (
          <p className="flex items-center gap-2 text-mac-body text-(--text-primary)"><CheckCircle2 className="w-4 h-4 text-(--text-success)" aria-hidden="true" /> Nada pendente na administração.</p>
        ) : (
          <ul className="divide-y divide-(--border-default)">
            {attention.map((a) => (
              <li key={a.key}>
                <Link to={a.to} className="flex items-center gap-3 min-h-11 py-1.5 text-mac-body text-(--text-primary) hover:underline rounded-[6px] focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
                  <AlertTriangle className="w-4 h-4 text-(--text-warning) shrink-0" aria-hidden="true" /><span className="flex-1">{a.text}</span><ChevronRight className="w-4 h-4 text-(--text-secondary)" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {failed && <p className="text-mac-caption text-(--text-secondary)">Algumas contagens não carregaram agora; os atalhos abaixo funcionam.</p>}
      </section>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {cards.map((card) => (
          <Link key={card.to} to={card.to}
            className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-4 flex items-start gap-3 hover:bg-(--bg-hover) active:scale-[0.99] transition duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
            <span className={`w-9 h-9 rounded-(--radius-control) flex items-center justify-center shrink-0 ${card.color}`} aria-hidden="true">
              <card.icon className="w-4 h-4 text-white" strokeWidth={2.25} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-mac-body font-semibold text-(--text-primary)">{card.title}</span>
              <span className="block text-mac-caption text-(--text-secondary) mb-1">{card.description}</span>
              <span className="block text-mac-caption text-(--text-accent) font-medium">{card.stat}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
