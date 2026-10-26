import { useEffect, useState } from "react";
import { Outlet, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { User, Building2, Users as UsersIcon, Lock, Sliders, Archive, Tags, ChevronRight, ChevronLeft, Search, LayoutGrid } from "lucide-react";
import { useAuthContext } from "@/lib/AuthContext";
import { useCompany } from "@/lib/CompanyContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";

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
  { to: "/settings/profile", icon: User, label: "Perfil", color: "bg-blue-500", adminOnly: false, supremoOnly: false, group: "Conta", keywords: ["nome", "avatar", "username"] },
  { to: "/settings/security", icon: Lock, label: "Segurança", color: "bg-red-500", adminOnly: false, supremoOnly: false, group: "Conta", keywords: ["senha", "trocar senha", "password"] },
  { to: "/settings/admin", icon: LayoutGrid, label: "Visão geral", color: "bg-teal-600", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["administração", "resumo", "painel", "overview"] },
  { to: "/settings/organization", icon: Building2, label: "Organização", color: "bg-slate-500", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["empresa", "cnpj", "desativar", "reativar", "perfil fiscal"] },
  { to: "/settings/users", icon: UsersIcon, label: "Usuários & Papéis", color: "bg-indigo-500", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["usuário", "membro", "grupo", "grupos", "permissão", "acesso", "operador", "visualizador", "admin", "explain access"] },
  { to: "/settings/metadata", icon: Tags, label: "Metadados", color: "bg-orange-500", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["campo", "campos", "cpf", "cnpj", "catálogo", "aplicação na árvore", "herança", "obrigatório"] },
  { to: "/settings/retention", icon: Archive, label: "Retenção", color: "bg-amber-600", adminOnly: true, supremoOnly: false, group: "Organização", keywords: ["lixeira", "política", "hold", "legal hold", "descarte", "certificado", "fila", "purga"] },
  { to: "/settings/preferences", icon: Sliders, label: "Preferências", color: "bg-purple-500", adminOnly: false, supremoOnly: false, group: "Aplicativo", keywords: ["tema", "dark mode", "modo escuro", "densidade"] },
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
    // Mobile: master-detail estilo iOS Settings. A lista (master) e o
    // conteúdo de uma seção (detail) nunca aparecem juntos — só um dos dois
    // ocupa a tela inteira por vez, com um botão "Voltar" no detalhe.
    if (atIndex) {
      // "Perfil" some da lista de linhas — vira o cartão de identidade no
      // topo (igual ao cartão "Apple Account" do iOS), não uma linha comum.
      const listTabs = visibleTabs.filter((t) => t.to !== "/settings/profile");
      const initials = (user?.full_name ?? user?.username ?? "?").split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
      return (
        <div className="flex flex-col h-[calc(100%+3rem)] -mt-6 py-2">
          <div className="px-1 pb-3 shrink-0">
            <h1 className="text-mac-title-2 font-bold text-(--text-primary)">Configurações</h1>
          </div>
          {/* No iOS real o conteúdo fica sempre no topo, mesmo quando é
              curto — o fundo simplesmente continua vazio até o fim da tela,
              sem nada tentando "preencher" o espaço. flex-1 aqui só garante
              que essa área ocupe a altura disponível (pro scroll funcionar
              quando o conteúdo crescer), sem centralizar nada. */}
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
            {/* Cartão de identidade — mesmo padrão do topo do Settings do
                iOS real (avatar + nome + subtítulo + chevron, cartão próprio
                separado da lista abaixo). */}
            <NavLink
              to="/settings/profile"
              className="glass-panel glass-highlight-line rounded-(--radius-panel) glass-shadow flex items-center gap-3.5 px-4 py-3.5 active:bg-(--bg-hover) transition-colors duration-fast"
            >
              <div className="w-14 h-14 rounded-full bg-teal-600 flex items-center justify-center text-white text-mac-title3 font-semibold shrink-0">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-mac-callout font-semibold text-(--text-primary) truncate">{user?.full_name}</p>
                <p className="text-mac-caption text-(--text-tertiary) truncate">@{user?.username}{user?.role ? ` · ${user.role}` : ""}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-(--text-tertiary) shrink-0" />
            </NavLink>

            <nav className="glass-panel glass-highlight-line rounded-(--radius-panel) glass-shadow overflow-hidden divide-y divide-(--border-default) shrink-0">
              {listTabs.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  className="flex items-center gap-3 h-14 px-3.5 text-mac-body text-(--text-primary) active:bg-(--bg-hover) transition-colors duration-fast"
                >
                  <span className={`w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 ${tab.color}`}>
                    <tab.icon className="w-5 h-5 text-white" strokeWidth={2.25} />
                  </span>
                  <span className="flex-1 min-w-0 truncate">{tab.label}</span>
                  <ChevronRight className="w-4 h-4 text-(--text-tertiary) shrink-0" />
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col h-[calc(100%+3rem)] -mt-6 py-2">
        {/* Botão voltar só com ícone, circular e translúcido — o iOS atual
            não usa mais botão de texto ("‹ Configurações") na barra de
            navegação, só a seta dentro de um círculo. */}
        <button
          onClick={() => navigate("/settings")}
          aria-label="Voltar para Configurações"
          className="flex items-center justify-center w-9 h-9 -ml-1 mb-2 rounded-full bg-(--bg-hover) text-(--text-primary) shrink-0 self-start"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {/* Título do pane mora só aqui — as sub-páginas não repetem o nome
            (evita duplicar "Perfil"/"Segurança" tanto no header quanto no
            corpo). Conteúdo fica no topo (como no iOS real) — não centraliza. */}
        {activeTab && (
          <h2 className="px-1 pb-3 text-mac-title-2 font-bold text-(--text-primary) shrink-0">{activeTab.label}</h2>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    );
  }

  return (
    // Janela única (sidebar + conteúdo no MESMO cartão de vidro, separados só
    // por uma linha divisória) — igual ao System Settings real do macOS, que
    // vive dentro de um único frame de janela. A versão anterior usava dois
    // glass-panel flutuantes lado a lado com gap-4, o que lia como "duas
    // caixas" em vez de uma janela coesa. calc(100%+3rem)/-mt-6 é o mesmo
    // ajuste de Documents.tsx pra cancelar o padding vertical do AppShell.
    <div className="flex h-[calc(100%+3rem)] -mt-6 py-2 glass-panel glass-highlight-line rounded-(--radius-panel) glass-shadow overflow-hidden">
      <aside className="flex flex-col w-[240px] shrink-0 border-r border-(--border-default)">
        <div className="px-4 py-3 border-b border-(--border-default) shrink-0 space-y-2">
          <h1 className="text-mac-body font-semibold text-(--text-secondary)">Configurações</h1>
          {/* Campo de busca no topo da sidebar — presente em toda referência
              real de System Settings, ausente até agora no Docke. */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-placeholder) pointer-events-none" />
            <input
              type="search"
              value={sidebarQuery}
              onChange={(e) => setSidebarQuery(e.target.value)}
              placeholder="Buscar"
              className="w-full h-7 pl-8 pr-2 text-mac-caption bg-(--bg-hover) rounded-[6px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-2 focus:ring-teal-500/70"
            />
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-1.5">
          {(() => {
            const q = sidebarQuery.trim().toLowerCase();
            const filtered = visibleTabs.filter((tab) =>
              tab.label.toLowerCase().includes(q) || tab.keywords.some((k) => k.includes(q))
            );
            const groups = Array.from(new Set(filtered.map((t) => t.group)));
            return groups.map((group, gi) => (
              <div key={group} className={gi > 0 ? "mt-3" : ""}>
                {/* Cabeçalho de seção — mesmo estilo caption/uppercase usado
                    nos agrupamentos da sidebar de pastas (Ancorados/Locais em
                    Documents.tsx), só que sem disclosure: System Settings
                    real não recolhe grupos, só separa visualmente. */}
                <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-(--text-tertiary)">{group}</p>
                <div className="space-y-0.5">
                  {filtered.filter((t) => t.group === group).map((tab) => (
                    <NavLink
                      key={tab.to}
                      to={tab.to}
                      className={({ isActive }) =>
                        // Preenchimento sólido no item selecionado (não um tint sutil)
                        // — igual ao destaque de seleção real do System Settings.
                        `flex items-center gap-2.5 h-9 px-2.5 rounded-sm text-mac-body whitespace-nowrap transition-colors duration-fast ${
                          isActive
                            ? "bg-teal-500 text-white font-medium"
                            : "text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)"
                        }`
                      }
                    >
                      <span className={`w-5 h-5 rounded-[6px] flex items-center justify-center shrink-0 ${tab.color}`}>
                        <tab.icon className="w-3 h-3 text-white" strokeWidth={2.25} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {tab.label}
                        {/* Fase 10.4: quando o match veio de um termo interno
                            (não do rótulo da aba), mostra qual foi — mesma
                            transparência do "found in" do System Settings. */}
                        {q && !tab.label.toLowerCase().includes(q) && (
                          <span className="block text-[10px] opacity-70 truncate font-normal">
                            em "{tab.keywords.find((k) => k.includes(q))}"
                          </span>
                        )}
                      </span>
                    </NavLink>
                  ))}
                </div>
              </div>
            ));
          })()}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {/* Título do pane mora só aqui, e o conteúdo tem largura máxima —
            System Settings nunca estica formulários/group boxes pra ocupar
            uma janela larga inteira, mantém foco e legibilidade. */}
        <div className="max-w-[720px] space-y-6">
          {activeTab && <h2 className="text-mac-title3 font-semibold text-(--text-primary)">{activeTab.label}</h2>}
          <Outlet />
        </div>
      </div>
    </div>
  );
}
