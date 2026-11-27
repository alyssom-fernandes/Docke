import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Building2, KeyRound, SlidersHorizontal, ChevronRight } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Input from "@/components/ui/Input";
import SaveBar from "@/components/shared/SaveBar";

const ROLE_LABEL: Record<string, string> = { visualizador: "Visualizador", operador: "Operador", admin: "Administrador", supremo: "Administrador geral" };

/**
 * Perfil (A8-06..A8-08): nome editável com Enter, aviso ao sair com
 * alteração pendente, e-mail, as empresas com o papel em cada uma e atalhos
 * para Segurança e Preferências. O selo mostra o papel de verdade, não o
 * código interno.
 */
export default function Profile() {
  usePageTitle("Perfil");
  const { user, updateProfile } = useAuthContext();
  const { companies } = useCompany();
  const { success, error: showError } = useToast();
  const [saving, setSaving] = useState(false);
  const [fullName, setFullName] = useState(user?.full_name ?? "");

  useEffect(() => { if (user) setFullName(user.full_name); }, [user]);

  const dirty = fullName.trim() !== "" && fullName.trim() !== user?.full_name;

  // Alteração não salva não some em silêncio ao fechar ou recarregar a aba.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  async function handleSave() {
    if (!dirty) return;
    setSaving(true);
    try {
      await updateProfile(fullName.trim());
      success("Nome atualizado.");
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível atualizar o perfil.");
    } finally {
      setSaving(false);
    }
  }

  const initials = (user?.full_name ?? user?.username ?? "?").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  return (
    <div className="space-y-4">
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-5 sm:p-6">
        <form className="max-w-[560px] space-y-6" onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-(--accent) flex items-center justify-center text-white text-mac-title3 font-semibold shrink-0" aria-hidden="true">{initials}</div>
            <div className="min-w-0">
              <p className="text-mac-callout font-semibold text-(--text-primary) truncate">{user?.full_name}</p>
              <p className="text-mac-body text-(--text-secondary) truncate">{user?.email ?? `@${user?.username}`}</p>
              {user?.role === "supremo" && <span className="inline-block mt-1 text-mac-caption px-2 py-0.5 rounded-full bg-(--accent) text-white font-medium">Administrador geral</span>}
            </div>
          </div>
          <div className="space-y-4">
            <Input label="Nome completo" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Seu nome completo" maxLength={120} autoComplete="name" />
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-mac-body">
              <dt className="text-(--text-secondary)">Nome de usuário</dt><dd className="text-(--text-primary)">@{user?.username}</dd>
              {user?.email && <><dt className="text-(--text-secondary)">E-mail de acesso</dt><dd className="text-(--text-primary) break-all">{user.email}</dd></>}
            </dl>
          </div>
          <button type="submit" className="sr-only">Salvar</button>
        </form>
        <SaveBar visible={dirty} saving={saving} onSave={handleSave} onDiscard={() => setFullName(user?.full_name ?? "")} />
      </div>

      <section aria-labelledby="perfil-empresas" className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 sm:p-6 space-y-2">
        <h2 id="perfil-empresas" className="text-mac-body font-semibold text-(--text-primary)">Suas empresas</h2>
        <ul className="divide-y divide-(--border-default)">
          {companies.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2 min-h-11">
              <Building2 className="w-4 h-4 text-(--text-secondary) shrink-0" aria-hidden="true" />
              <span className="flex-1 text-mac-body text-(--text-primary) truncate">{c.name}</span>
              <span className="text-mac-caption text-(--text-secondary)">{ROLE_LABEL[c.permission_level ?? ""] ?? c.permission_level}</span>
            </li>
          ))}
        </ul>
      </section>

      <nav aria-label="Atalhos da conta" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {[{ to: "/settings/security", icon: KeyRound, t: "Senha e segurança", d: "Trocar a senha e ver os acessos." }, { to: "/settings/preferences", icon: SlidersHorizontal, t: "Preferências", d: "Tema e densidade das listas." }].map((l) => (
          <Link key={l.to} to={l.to} className="glass-panel glass-blur-card rounded-(--radius-panel) p-4 flex items-center gap-3 hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
            <l.icon className="w-4 h-4 text-(--text-accent)" aria-hidden="true" />
            <span className="flex-1"><span className="block text-mac-body font-medium text-(--text-primary)">{l.t}</span><span className="block text-mac-caption text-(--text-secondary)">{l.d}</span></span>
            <ChevronRight className="w-4 h-4 text-(--text-secondary)" aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </div>
  );
}
