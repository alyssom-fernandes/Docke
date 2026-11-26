import { useEffect, useId, useState } from "react";
import { Copy, Check, Link2, Lock, Eye, EyeOff, Trash2, Pencil, AlertTriangle } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Dropdown from "@/components/ui/Dropdown";
import ConfirmModal from "@/components/ui/ConfirmModal";

interface ShareLink {
  id: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_accessed_at: string | null;
  created_at: string;
  has_password: boolean;
  max_views?: number | null;
  allow_download?: boolean;
}

// Dias de cada validade (sem validade = infinito, fica de fora quando há limite).
const DIAS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30 };

const EXPIRY = [
  { value: "24h", label: "24 horas" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "custom", label: "Escolher a data" },
  { value: "never", label: "Sem validade" },
];

// Pastas e nomes que sugerem dados pessoais ou de saúde (achado A5-84).
const SENSITIVE = /(holerite|aso|atestado|exame|sa[uú]de|rh|folha|f[eé]rias|rescis|admiss|prontu|cpf|rg)/i;

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/**
 * Compartilhar por link (achados A5-77..A5-85): validade (inclusive data
 * escolhida), senha em campo protegido, limite de aberturas, "só visualizar",
 * aviso para dados pessoais, links existentes editáveis e com acessos à vista.
 */
export default function ShareModal({ resourceType, resourceId, name, onClose, onChanged }: {
  resourceType: "document" | "folder"; resourceId: string; name: string; onClose: () => void; onChanged?: (activeCount: number) => void;
}) {
  const { success, error: showError } = useToast();
  const uid = useId();
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [expiry, setExpiry] = useState("7d");
  const [customDate, setCustomDate] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [limit, setLimit] = useState("");
  const [viewOnly, setViewOnly] = useState(false);
  // B3.2.5: termo de confidencialidade aceito pelo visitante (com o nome) antes de abrir.
  const [useTerms, setUseTerms] = useState(false);
  const [terms, setTerms] = useState("Ao abrir, declaro que vou usar estes documentos só para a finalidade combinada com quem os enviou, sem repassar a terceiros, e que meu acesso fica registrado.");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);
  const [editing, setEditing] = useState<ShareLink | null>(null);

  // Política de links da empresa (FA-A5-08): senha obrigatória e validade máxima.
  const { current } = useCompany();
  const [pol, setPol] = useState<{ require_password: boolean; max_days: number | null }>({ require_password: false, max_days: null });
  useEffect(() => {
    if (!current) return;
    api.get(`/companies/${current.id}/share-policy`).then((r) => {
      setPol(r.data);
      if (r.data?.require_password) setUsePassword(true);
      const max = r.data?.max_days as number | null;
      if (max) setExpiry((e) => (DIAS[e] !== undefined && DIAS[e] <= max ? e : max >= 7 ? "7d" : "24h"));
    }).catch(() => {});
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const expiryOpts = pol.max_days ? EXPIRY.filter((o) => o.value === "custom" || (DIAS[o.value] !== undefined && DIAS[o.value] <= pol.max_days!)) : EXPIRY;
  const maxData = pol.max_days ? new Date(Date.now() + pol.max_days * 86400000).toISOString().slice(0, 10) : undefined;

  const active = (links ?? []).filter((l) => !l.revoked_at && (!l.expires_at || new Date(l.expires_at) > new Date()));
  const sensitive = SENSITIVE.test(name);

  function load() {
    setLoadError(false);
    api.get<ShareLink[]>("/shares", { params: { resource_type: resourceType, resource_id: resourceId } })
      .then((r) => { setLinks(r.data); onChanged?.(r.data.filter((l) => !l.revoked_at).length); })
      .catch(() => { setLoadError(true); setLinks([]); });
  }
  useEffect(load, [resourceType, resourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    if (usePassword && password.length < 4) { showError("Use uma senha com pelo menos 4 caracteres."); return; }
    if (expiry === "custom" && !customDate) { showError("Escolha a data de validade."); return; }
    setCreating(true);
    try {
      const { data } = await api.post("/shares", {
        resource_type: resourceType, resource_id: resourceId,
        password: usePassword ? password : null,
        expires_in: expiry, custom_expires_at: expiry === "custom" ? customDate : null,
        max_views: limit ? Number(limit) : null,
        allow_download: !viewOnly,
        terms_text: useTerms && terms.trim() ? terms.trim() : null,
      });
      setCreated(`${window.location.origin}/s/${data.token}`);
      setCopied(false);
      setPassword("");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar o link.");
    } finally {
      setCreating(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
      success("Link copiado.");
    } catch {
      showError("Não foi possível copiar. Selecione o link e copie com Ctrl+C.");
    }
  }

  async function revoke(link: ShareLink) {
    try {
      await api.delete(`/shares/${link.id}`);
      setRevoking(null);
      success("Link revogado. Quem tentar abrir verá que ele não vale mais.");
      setLinks((prev) => (prev ?? []).map((l) => (l.id === link.id ? { ...l, revoked_at: new Date().toISOString() } : l)));
      onChanged?.(active.length - 1);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível revogar o link.");
    }
  }

  const field = "w-full h-9 pointer-coarse:h-11 px-3 text-mac-body pointer-coarse:text-[16px] bg-(--bg-card) border border-(--border-control) rounded-(--radius-control) text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)";

  return (
    <>
      <Dialog onClose={onClose} title={`Compartilhar "${name}"`} description="Quem tiver o link abre sem precisar de conta no Docke." size="md">
        <div className="space-y-4">
          {sensitive && (
            <div role="note" className="flex gap-2 rounded-(--radius-control) border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 text-mac-body text-(--text-primary)">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-(--text-warning)" aria-hidden />
              Pode conter dados pessoais ou de saúde. Prefira senha, validade curta e "só visualizar".
            </div>
          )}

          {created ? (
            <div className="reveal space-y-2">
              <label htmlFor={`${uid}-link`} className="block text-mac-body font-medium text-(--text-primary)">Link criado. Copie agora: por segurança ele não é mostrado de novo.</label>
              <div className="flex gap-2">
                <input id={`${uid}-link`} readOnly value={created} onFocus={(e) => e.target.select()} className={`${field} font-mono text-mac-caption`} />
                <Button onClick={copy} aria-label="Copiar link">{copied ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}{copied ? "Copiado" : "Copiar"}</Button>
              </div>
              <button onClick={() => setCreated(null)} className="text-mac-body text-(--text-accent) underline-offset-2 hover:underline min-h-6 pointer-coarse:min-h-11">Criar outro link</button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <span id={`${uid}-val`} className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Validade</span>
                  <Dropdown value={expiry} onChange={setExpiry} options={expiryOpts} ariaLabelledby={`${uid}-val`} />
                  {pol.max_days && <p className="mt-1 text-mac-caption text-(--text-secondary)">A empresa permite no máximo {pol.max_days} {pol.max_days === 1 ? "dia" : "dias"}.</p>}
                </div>
                {expiry === "custom" && (
                  <div>
                    <label htmlFor={`${uid}-data`} className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Vale até</label>
                    <input id={`${uid}-data`} type="date" min={new Date().toISOString().slice(0, 10)} max={maxData} value={customDate} onChange={(e) => setCustomDate(e.target.value)} className={field} />
                  </div>
                )}
                <div>
                  <label htmlFor={`${uid}-lim`} className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Limite de aberturas</label>
                  <input id={`${uid}-lim`} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="Sem limite" className={field} />
                </div>
              </div>
              <label className="flex items-center gap-2.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer text-mac-body text-(--text-primary)">
                <Checkbox checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} />
                Só visualizar (sem botão de baixar)
              </label>
              <label className="flex items-center gap-2.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer text-mac-body text-(--text-primary)">
                <Checkbox checked={useTerms} onChange={(e) => setUseTerms(e.target.checked)} />
                Pedir aceite de termo de confidencialidade (com o nome de quem abre)
              </label>
              {useTerms && (
                <div className="reveal">
                  <label htmlFor={`${uid}-termo`} className="sr-only">Texto do termo</label>
                  <textarea id={`${uid}-termo`} rows={3} maxLength={4000} value={terms} onChange={(e) => setTerms(e.target.value)}
                    className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
                  <p className="mt-1 text-mac-caption text-(--text-secondary)">O nome e o aceite ficam no registro de acessos do link.</p>
                </div>
              )}
              <label className="flex items-center gap-2.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer text-mac-body text-(--text-primary)">
                <Checkbox checked={usePassword} disabled={pol.require_password} onChange={(e) => setUsePassword(e.target.checked)} />
                Pedir senha{pol.require_password && <span className="text-mac-caption text-(--text-secondary)">(obrigatória nesta empresa)</span>}
              </label>
              {usePassword && (
                <div className="reveal">
                  <label htmlFor={`${uid}-senha`} className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Senha do link</label>
                  <div className="relative">
                    <input id={`${uid}-senha`} type={showPassword ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${field} pr-11`} />
                    <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"} aria-pressed={showPassword}
                      className="absolute right-0.5 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-(--radius-control) text-(--text-secondary) hover:bg-(--bg-hover)">
                      {showPassword ? <EyeOff className="w-4 h-4" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
                    </button>
                  </div>
                  <p className="mt-1 text-mac-caption text-(--text-secondary)">Envie a senha por outro canal (telefone, mensagem separada).</p>
                </div>
              )}
              <Button onClick={create} loading={creating} className="w-full"><Link2 className="w-4 h-4" aria-hidden /> Criar link</Button>
            </div>
          )}

          <section aria-labelledby={`${uid}-ativos`} className="border-t border-(--border-default) pt-3">
            <h3 id={`${uid}-ativos`} className="text-mac-body font-semibold text-(--text-primary) mb-2">Links ativos{links ? ` (${active.length})` : ""}</h3>
            {links === null ? (
              <div className="h-12 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" aria-label="Carregando links" />
            ) : loadError ? (
              <p role="alert" className="text-mac-body text-(--text-secondary)">Não foi possível carregar os links. <button onClick={load} className="font-medium text-(--text-accent) underline underline-offset-2">Tentar de novo</button></p>
            ) : active.length === 0 ? (
              <p className="text-mac-body text-(--text-secondary)">Nenhum link ativo para {resourceType === "document" ? "este documento" : "esta pasta"}.</p>
            ) : (
              <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
                {active.map((l) => {
                  const soon = l.expires_at && new Date(l.expires_at).getTime() - Date.now() < 2 * 86400000;
                  return (
                    <li key={l.id} className="flex items-center gap-2 px-3 py-2">
                      <div className="flex-1 min-w-0 text-mac-caption">
                        <p className="text-(--text-primary) flex flex-wrap items-center gap-x-1.5">
                          Criado em {fmtDate(l.created_at)}
                          {l.has_password && <span className="inline-flex items-center gap-0.5 text-(--text-secondary)"><Lock className="w-3 h-3" aria-hidden /> com senha</span>}
                          {l.allow_download === false && <span className="text-(--text-secondary)">· só visualizar</span>}
                        </p>
                        <p className={soon ? "text-(--text-warning)" : "text-(--text-secondary)"}>
                          {l.expires_at ? `Vale até ${fmtDate(l.expires_at)}` : "Sem validade"} · {l.view_count} {l.view_count === 1 ? "abertura" : "aberturas"}{l.max_views ? ` de ${l.max_views}` : ""}
                          {l.last_accessed_at ? ` · última em ${fmtDate(l.last_accessed_at)}` : ""}
                        </p>
                      </div>
                      <button onClick={() => setEditing(l)} aria-label="Editar este link" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)"><Pencil className="w-3.5 h-3.5" aria-hidden /></button>
                      <button onClick={() => setRevoking(l)} aria-label="Revogar este link" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-danger) hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5" aria-hidden /></button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </Dialog>
      {revoking && (
        <ConfirmModal
          title="Revogar este link?"
          description="Quem abrir o link a partir de agora verá que ele não vale mais. Uma página que já estava aberta pode continuar funcionando por até 1 hora."
          confirmLabel="Revogar"
          danger
          onConfirm={() => revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
      {editing && <EditShare link={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
}

function EditShare({ link, onClose, onSaved }: { link: ShareLink; onClose: () => void; onSaved: () => void }) {
  const { success, error: showError } = useToast();
  const uid = useId();
  const [expiry, setExpiry] = useState<string>("");
  const [customDate, setCustomDate] = useState("");
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [limit, setLimit] = useState(link.max_views ? String(link.max_views) : "");
  const [viewOnly, setViewOnly] = useState(link.allow_download === false);
  const [saving, setSaving] = useState(false);
  const field = "w-full h-9 pointer-coarse:h-11 px-3 text-mac-body bg-(--bg-card) border border-(--border-control) rounded-(--radius-control) text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)";

  async function save() {
    const body: Record<string, unknown> = { allow_download: !viewOnly, max_views: limit ? Number(limit) : 0 };
    if (expiry) { body.expires_in = expiry; if (expiry === "custom") body.custom_expires_at = customDate; }
    if (removePassword) body.password = "";
    else if (password) body.password = password;
    setSaving(true);
    try {
      await api.patch(`/shares/${link.id}`, body);
      success("Link atualizado.");
      onSaved();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onClose={onClose} title="Editar link" size="sm" busy={saving}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button><Button onClick={save} loading={saving}>Salvar</Button></>}>
      <div className="space-y-3">
        <div>
          <span id={`${uid}-v`} className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Nova validade</span>
          <Dropdown value={expiry} onChange={setExpiry} placeholder="Manter a atual" options={[{ value: "", label: "Manter a atual" }, ...EXPIRY]} ariaLabelledby={`${uid}-v`} />
        </div>
        {expiry === "custom" && (
          <div>
            <label htmlFor={`${uid}-d`} className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Vale até</label>
            <input id={`${uid}-d`} type="date" min={new Date().toISOString().slice(0, 10)} value={customDate} onChange={(e) => setCustomDate(e.target.value)} className={field} />
          </div>
        )}
        <div>
          <label htmlFor={`${uid}-l`} className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Limite de aberturas</label>
          <input id={`${uid}-l`} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="Sem limite" className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-s`} className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">{link.has_password ? "Trocar a senha" : "Pôr senha"}</label>
          <input id={`${uid}-s`} type="password" autoComplete="new-password" value={password} disabled={removePassword} onChange={(e) => setPassword(e.target.value)} placeholder="Deixe em branco para não mudar" className={field} />
        </div>
        {link.has_password && (
          <label className="flex items-center gap-2.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer text-mac-body text-(--text-primary)">
            <Checkbox checked={removePassword} onChange={(e) => setRemovePassword(e.target.checked)} /> Tirar a senha
          </label>
        )}
        <label className="flex items-center gap-2.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer text-mac-body text-(--text-primary)">
          <Checkbox checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} /> Só visualizar
        </label>
      </div>
    </Dialog>
  );
}
