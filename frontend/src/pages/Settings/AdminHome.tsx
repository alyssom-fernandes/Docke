import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Users as UsersIcon, Tags, Archive, ChevronRight } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";

interface CardDef {
  to: string;
  icon: typeof Building2;
  color: string;
  title: string;
  description: string;
  stat: string | null;
}

/**
 * Fase 10.5 — Home de Administração: painel de cards (visão geral +
 * atalho), em vez de cair direto numa aba específica sem contexto do
 * conjunto. Cada card busca uma contagem real (não é decorativo) e navega
 * pra aba correspondente ao clicar — mesmo padrão de "overview" usado por
 * System Settings/Console de admin em geral.
 */
export default function AdminHome() {
  usePageTitle("Administração");
  const { current, companies } = useCompany();
  const navigate = useNavigate();
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [fieldCount, setFieldCount] = useState<number | null>(null);
  const [policyCount, setPolicyCount] = useState<number | null>(null);

  useEffect(() => {
    if (!current) return;
    api.get<{ user_id: string }[]>(`/companies/${current.id}/members`)
      .then((r) => setMemberCount(new Set(r.data.map((m) => m.user_id)).size))
      .catch(() => setMemberCount(null));
    api.get<unknown[]>("/custom-fields", { params: { company_id: current.id } })
      .then((r) => setFieldCount(Array.isArray(r.data) ? r.data.length : null))
      .catch(() => setFieldCount(null));
    api.get<unknown[]>(`/companies/${current.id}/retention/policies`)
      .then((r) => setPolicyCount(Array.isArray(r.data) ? r.data.length : null))
      .catch(() => setPolicyCount(null));
  }, [current?.id]);

  const cards: CardDef[] = [
    {
      to: "/settings/organization", icon: Building2, color: "bg-slate-500", title: "Organização",
      description: "Empresas, dados fiscais e ativação.",
      stat: companies ? `${companies.length} ${companies.length === 1 ? "empresa" : "empresas"}` : null,
    },
    {
      to: "/settings/users", icon: UsersIcon, color: "bg-indigo-500", title: "Usuários & Papéis",
      description: "Membros, grupos e concessões de acesso.",
      stat: memberCount === null ? null : `${memberCount} ${memberCount === 1 ? "usuário" : "usuários"}`,
    },
    {
      to: "/settings/metadata", icon: Tags, color: "bg-orange-500", title: "Metadados",
      description: "Campos personalizados e aplicação por pasta.",
      stat: fieldCount === null ? null : `${fieldCount} ${fieldCount === 1 ? "campo" : "campos"}`,
    },
    {
      to: "/settings/retention", icon: Archive, color: "bg-amber-600", title: "Retenção",
      description: "Políticas, legal holds e fila de descarte.",
      stat: policyCount === null ? null : `${policyCount} ${policyCount === 1 ? "política" : "políticas"}`,
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-mac-body text-[var(--text-secondary)]">
        Visão geral da administração de <strong className="text-[var(--text-primary)]">{current?.name ?? "…"}</strong>.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map((card) => (
          <button
            key={card.to}
            onClick={() => navigate(card.to)}
            className="text-left glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-4 flex items-start gap-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast group"
          >
            <span className={`w-9 h-9 rounded-[var(--radius-control)] flex items-center justify-center flex-shrink-0 ${card.color}`}>
              <card.icon className="w-4 h-4 text-white" strokeWidth={2.25} />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-mac-body font-semibold text-[var(--text-primary)]">{card.title}</p>
              <p className="text-mac-caption text-[var(--text-secondary)] mb-1">{card.description}</p>
              <p className="text-mac-caption text-teal-500 font-medium">
                {card.stat ?? <span className="inline-block w-16 h-3 bg-[var(--bg-hover)] rounded-full animate-pulse align-middle" />}
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)] flex-shrink-0 group-hover:translate-x-0.5 transition-transform duration-fast" />
          </button>
        ))}
      </div>
    </div>
  );
}
