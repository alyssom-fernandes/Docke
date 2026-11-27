import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Building2, KeyRound, SlidersHorizontal, ChevronRight } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Input from "@/components/ui/Input";
import Avatar from "@/components/ui/Avatar";
import api from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import SaveBar from "@/components/shared/SaveBar";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";

const ROLE_LABEL: Record<string, string> = { visualizador: "Visualizador", operador: "Operador", admin: "Administrador", supremo: "Administrador geral" };

/**
 * Perfil (A8-06..A8-08): nome editável com Enter, aviso ao sair com
 * alteração pendente, e-mail, as empresas com o papel em cada uma e atalhos
 * para Segurança e Preferências. O selo mostra o papel de verdade, não o
 * código interno.
 */
export default function Profile() {
  usePageTitle("Perfil");
  const { user, updateProfile, setAvatar } = useAuthContext();
  const [enviandoFoto, setEnviandoFoto] = useState(false);
  const fotoRef = useRef<HTMLInputElement>(null);
  async function trocarFoto(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { showError("Use uma imagem PNG, JPEG ou WebP."); return; }
    if (file.size > 2 * 1024 * 1024) { showError("A foto pode ter até 2 MB."); return; }
    setEnviandoFoto(true);
    try {
      const { data } = await api.post("/auth/avatar/upload-url", { content_type: file.type, size_bytes: file.size });
      const put = await fetch(data.upload_url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!put.ok) throw new Error("O armazenamento recusou a foto.");
      const r = await api.put("/auth/avatar", { avatar_key: data.avatar_key });
      setAvatar(r.data.avatar_url ?? null);
      success("Foto atualizada.");
    } catch (e) {
      showError(friendlyError(e, "Não foi possível trocar a foto."));
    } finally {
      setEnviandoFoto(false);
      if (fotoRef.current) fotoRef.current.value = "";
    }
  }
  async function tirarFoto() {
    setEnviandoFoto(true);
    try { await api.put("/auth/avatar", { avatar_key: null }); setAvatar(null); success("Foto removida."); }
    catch (e) { showError(friendlyError(e, "Não foi possível tirar a foto.")); }
    finally { setEnviandoFoto(false); }
  }
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

  // Trocar de painel ou de tela pelo app também avisa (A8-07).
  const guard = useUnsavedGuard(dirty);

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
            <div className="flex flex-col items-center gap-1 shrink-0">
              {user?.avatar_url
                ? <Avatar name={user.full_name} src={user.avatar_url} size="lg" />
                : <div className="w-14 h-14 rounded-full bg-(--accent) flex items-center justify-center text-white text-mac-title3 font-semibold" aria-hidden="true">{initials}</div>}
              {user?.username !== "demo" && (
                <span className="flex gap-2 text-mac-caption">
                  <button type="button" disabled={enviandoFoto} onClick={() => fotoRef.current?.click()} className="font-medium text-(--text-accent) hover:underline disabled:opacity-(--opacity-disabled)">{user?.avatar_url ? "Trocar" : "Pôr foto"}</button>
                  {user?.avatar_url && <button type="button" disabled={enviandoFoto} onClick={tirarFoto} className="text-(--text-secondary) hover:underline">Tirar</button>}
                </span>
              )}
              <input ref={fotoRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Escolher foto" onChange={(e) => trocarFoto(e.target.files?.[0])} />
            </div>
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
        {guard}
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
