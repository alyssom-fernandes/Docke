import { useEffect, useState } from "react";
import { Outlet, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { User, Building2, Users as UsersIcon, Lock, Sliders, Archive, Tags, ChevronRight, ChevronLeft, Search, LayoutGrid, ShieldAlert } from "lucide-react";
import { useAuthContext } from "@/lib/AuthContext";
import { useCompany } from "@/lib/CompanyContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { PageHeader } from "@/components/layout/window";
import Avatar from "@/components/ui/Avatar";
import Footer from "@/components/layout/Footer";

// Lembra o último painel visitado (regra do HIG: "Restore the most recently
// viewed pane") — sem isso, /settings sempre caía em Perfil mesmo se o
// usuário tivesse acabado de sair de Segurança, por exemplo.
const LAST_PANE_KEY = "docke_settings_last_pane";

// Ícone dentro de um "chip" colorido por categoria — padrão macOS Settings
// (Screen Time, Family etc.): cada item tem uma cor própria, não um ícone
// monocromático solto. Cores distintas ajudam a reconhecer a seção de relance.
// Fase 10.4: busca com anchor — cada aba carrega uma lista de termos internos
// (subseções, ações, conceitos) pra que digitar "grupo" ou "hold" encontre a
// aba certa mesmo sem a palavra aparecer no rótulo — mesmo princípio de
// busca do System Settings da Apple.
const TABS = [
  { to: "/settings/profile", icon: User, label: "Perfil", color: "bg-blue-500", adminOnly: false, supremoOnly: false, group: "Conta", keywords: ["nome", "avatar", "username", "e-mail", "email", "conta", "minhas empresas"] },
  { to: "/settings/security", icon: Lock, label: "Segurança", color: "bg-red-500", adminOnly: false, supremoOnly: false, group: "Conta", keywords: ["senha", "trocar senha", "password", "mfa", "duas etapas", "2fa", "autenticação", "segurança da conta"] },
  { to: "/settings/admin", icon: LayoutGrid, label: "Visão geral", color: "bg-(--accent)", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["administração", "resumo", "painel", "overview"] },
  { to: "/settings/organization", icon: Building2, label: "Organização", color: "bg-slate-500", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["empresa", "cnpj", "desativar", "reativar", "perfil fiscal", "logo", "regime", "segmento", "exportar", "exportação", "backup", "ler de novo", "ocr"] },
  { to: "/settings/users", icon: UsersIcon, label: "Pessoas e acessos", color: "bg-indigo-500", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["usuário", "membro", "grupo", "grupos", "permissão", "acesso", "operador", "visualizador", "admin", "explain access"] },
  { to: "/settings/metadata", icon: Tags, label: "Metadados", color: "bg-orange-500", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["campo", "campos", "cpf", "cnpj", "catálogo", "aplicação na árvore", "herança", "obrigatório"] },
  { to: "/settings/retention", icon: Archive, label: "Retenção e descarte", color: "bg-amber-600", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["lixeira", "política", "hold", "legal hold", "descarte", "certificado", "fila", "purga"] },
  { to: "/settings/privacy", icon: ShieldAlert, label: "Privacidade (LGPD)", color: "bg-rose-600", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["lgpd", "titular", "cpf", "dado pessoal", "dado sensível", "saúde", "aso", "holerite", "privacidade", "encarregado", "dpo"] },
  { to: "/settings/preferences", icon: Sliders, label: "Preferências", color: "bg-purple-500", adminOnly: false, supremoOnly: false, group: "Aplicativo", keywords: ["tema", "dark mode", "modo escuro", "claro", "densidade", "aparência", "atalhos"] },
];

function useVisibleTabs() {
  const { user } = useAuthContext();
  const { current } = useCompany();
  const isSupremo = user?.role === "supremo";
  const canManage = isSupremo || current?.permission_level === "admin";
  return TABS.filter((t) => {
    if (t.supremoOnly) return isSupremo;
    if (t.adminOnly) return canManage;
    return true;
  });
}

// Rota índice (/settings sem sub-rota): no desktop sempre existe um painel de
// conteúdo à direita, então cai direto em Perfil. No mobile o índice É a
// lista de menu (padrão iOS Settings) — não deve pular pra dentro de uma
// seção, então não navega, deixa o SettingsLayout renderizar a lista.
export function SettingsIndex() {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  if (isDesktop) {
    const last = localStorage.getItem(LAST_PANE_KEY);
    return <Navigate to={last?.startsWith("/settings/") ? last : "/settings/profile"} replace />;
  }
  return null;
}

export default function SettingsLayout() {
  const visibleTabs = useVisibleTabs();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const atIndex = location.pathname === "/settings" || location.pathname === "/settings/";
  const [sidebarQuery, setSidebarQuery] = useState("");

  useEffect(() => {
    if (!atIndex) localStorage.setItem(LAST_PANE_KEY, location.pathname);
  }, [location.pathname, atIndex]);

  // Nome do pane atual — mostrado uma única vez (na moldura, não duplicado
  // dentro de cada sub-página) igual ao título de janela do System Settings.
  const activeTab = TABS.find((t) => location.pathname.startsWith(t.to));

  if (!isDesktop) {
    // Celular: lista agrupada do iOS (Ajustes do iPhone). A lista e o conteúdo
    // de uma seção nunca aparecem juntos; a seção tem o voltar em círculo.
    if (atIndex) {
      const listTabs = visibleTabs.filter((t) => t.to !== "/settings/profile");
      return (
        <div key={location.pathname} className="panel-in flex flex-col gap-5">
          <PageHeader title="Ajustes" />
          <NavLink to="/settings/profile" className="mac-group flex items-center gap-3.5 px-4 py-3 active:bg-(--control-fill)">
            <Avatar name={user?.full_name ?? user?.username ?? "?"} size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-[17px] font-semibold text-(--text-primary) truncate">{user?.full_name}</p>
              <p className="text-[13px] text-(--text-secondary) truncate">Perfil, senha e empresas</p>
            </div>
            <ChevronRight className="w-4 h-4 text-(--text-tertiary) shrink-0" aria-hidden />
          </NavLink>
          <nav aria-label="Seções dos ajustes" className="mac-group overflow-hidden">
            {listTabs.map((tab, i) => (
              <NavLink key={tab.to} to={tab.to} className="flex items-center gap-3 pl-3.5 min-h-12 text-[17px] text-(--text-primary) active:bg-(--control-fill)">
                <span className={`w-[30px] h-[30px] rounded-[7px] flex items-center justify-center shrink-0 ${tab.color}`}>
                  <tab.icon className="w-[18px] h-[18px] text-white" strokeWidth={2} aria-hidden />
                </span>
                <span className={`flex flex-1 min-w-0 items-center self-stretch pr-3.5 ${i > 0 ? "border-t border-(--separator-subtle)" : ""}`}>
                  <span className="flex-1 truncate">{tab.label}</span>
                  <ChevronRight className="w-4 h-4 text-(--text-tertiary) shrink-0" aria-hidden />
                </span>
              </NavLink>
            ))}
          </nav>
        </div>
      );
    }

    return (
      <div className="flex flex-col">
        <button
          onClick={() => navigate("/settings")}
          aria-label="Voltar para Ajustes"
          className="glass-capsule flex items-center justify-center size-9 mb-2 rounded-full text-(--text-primary) self-start active:scale-95"
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" />
        </button>
        {activeTab && <PageHeader title={activeTab.label} />}
        <div key={location.pathname} className="page-enter space-y-6">
          <Outlet />
        </div>
      </div>
    );
  }

  return (
    // Ajustes do Sistema do macOS 27: coluna de seções com a busca no topo,
    // ícone em bloco colorido e a seleção em cápsula; o nome da seção vai para
    // a barra de ferramentas da janela.
    <div className="flex h-full min-h-0">
      {activeTab && <PageHeader title={activeTab.label} subtitle="Ajustes" />}
      <aside className="flex flex-col w-[232px] shrink-0 border-r border-(--separator)">
        <div className="px-3 pt-1 pb-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-secondary) pointer-events-none" aria-hidden />
            <input
              type="search"
              aria-label="Buscar nos ajustes"
              value={sidebarQuery}
              onChange={(e) => setSidebarQuery(e.target.value)}
              placeholder="Buscar"
              className="mac-field w-full h-7 pl-7 pr-2 text-[13px] text-(--text-primary) placeholder:text-(--text-secondary)"
            />
          </div>
        </div>
        <nav aria-label="Seções dos ajustes" className="flex-1 overflow-y-auto px-2.5 pb-3">
          {(() => {
            const q = sidebarQuery.trim().toLowerCase();
            const filtered = visibleTabs.filter((tab) =>
              tab.label.toLowerCase().includes(q) || tab.keywords.some((k) => k.includes(q))
            );
            // Busca sem resultado diz o que tentar (A8-01), em vez de lista em branco.
            if (!filtered.length) return (
              <p role="status" className="px-2 py-3 text-[12px] text-(--text-secondary)">
                Nada nos ajustes com “{sidebarQuery.trim()}”. Tente senha, CNPJ, campos, prazos ou tema.
              </p>
            );
            const groups = Array.from(new Set(filtered.map((t) => t.group)));
            return groups.map((group, gi) => (
              <div key={group} className={gi > 0 ? "mt-3" : ""}>
                <p className="px-1.5 pt-1.5 pb-1 text-[11px] font-bold text-(--sidebar-header)">{group}</p>
                {filtered.filter((t) => t.group === group).map((tab) => (
                  <NavLink
                    key={tab.to}
                    to={tab.to}
                    className={({ isActive }) => `sidebar-item ${isActive ? "is-selected" : ""}`}
                  >
                    <span className={`w-5 h-5 rounded-[5px] flex items-center justify-center shrink-0 ${tab.color}`}>
                      <tab.icon className="w-3 h-3 text-white" strokeWidth={2.4} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1 truncate pl-0.5">
                      {tab.label}
                      {/* Quando o achado veio de um termo interno, mostra qual foi. */}
                      {q && !tab.label.toLowerCase().includes(q) && (
                        <span className="block text-[10px] leading-3 text-(--text-secondary) truncate font-normal">
                          em "{tab.keywords.find((k) => k.includes(q))}"
                        </span>
                      )}
                    </span>
                  </NavLink>
                ))}
              </div>
            ));
          })()}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto px-8 pt-4 pb-10">
        {/* O conteúdo não estica numa janela larga, como nos Ajustes do Sistema. */}
        <div key={location.pathname} className="page-enter mx-auto max-w-[680px] xl:max-w-[820px] 2xl:max-w-[960px] space-y-6">
          <Outlet />
        </div>
        <div className="mx-auto max-w-[680px] xl:max-w-[820px] 2xl:max-w-[960px]"><Footer /></div>
      </div>
    </div>
  );
}
