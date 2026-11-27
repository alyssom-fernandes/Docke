import { useEffect, useId, useRef, useState } from "react";
import { Building2, Plus, Image as ImageIcon, ChevronRight, ScrollText } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { friendlyError } from "@/lib/errors";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { TemplatesSection } from "@/components/documents/Templates";
import { useToast } from "@/lib/toast";
import { useAuthContext } from "@/lib/AuthContext";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/shared/EmptyState";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { validateValue } from "@/components/documents/fieldMasks";
import Dropdown from "@/components/ui/Dropdown";
import DataSection from "@/components/settings/DataSection";

interface Org {
  id: string;
  name: string;
  cnpj: string | null;
  logo_key: string | null;
  is_active: boolean;
  document_count: number;
  user_count: number;
}

function formatCnpj(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 14);
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

function OrgModal({ org, onClose, onDone }: { org: Org | null; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [name, setName] = useState(org?.name ?? "");
  const [cnpj, setCnpj] = useState(org?.cnpj ? formatCnpj(org.cnpj) : "");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cnpjError = cnpj ? validateValue("cnpj", cnpj) : null;
  const nameError = !name.trim() ? "Dê um nome à empresa." : null;

  useEffect(() => {
    if (!org?.logo_key) return;
    api.get(`/companies/${org.id}/logo-url`).then((r) => setLogoUrl(r.data.logo_url)).catch(() => setLogoUrl(null));
  }, [org?.id, org?.logo_key]);

  // Logo (A9-09): o backend devolve a URL assinada; o arquivo vai direto ao storage.
  async function uploadLogo(file: File) {
    if (!org) return;
    if (!["image/png", "image/jpeg", "image/svg+xml", "image/webp"].includes(file.type)) { showError("Use PNG, JPG, SVG ou WebP."); return; }
    if (file.size > 2 * 1024 * 1024) { showError("O logo pode ter até 2 MB."); return; }
    setUploading(true);
    try {
      const { data } = await api.post(`/companies/${org.id}/logo-upload-url`, { content_type: file.type });
      const put = await fetch(data.upload_url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!put.ok) throw new Error("upload");
      await api.patch(`/companies/${org.id}`, { logo_key: data.logo_key });
      setLogoUrl(URL.createObjectURL(file));
      success("Logo atualizado.");
      onDone();
    } catch {
      showError("Não foi possível enviar o logo. Tente de novo.");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setTouched(true);
    if (nameError || cnpjError) return;
    setSaving(true);
    try {
      if (org) {
        await api.patch(`/companies/${org.id}`, { name: name.trim(), cnpj: cnpj || null });
        success("Empresa atualizada.");
      } else {
        await api.post("/companies", { name: name.trim() });
        success("Empresa criada.");
      }
      onDone();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível salvar a empresa.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onClose={onClose} title={org ? `Editar ${org.name}` : "Nova empresa"} size="md" busy={saving || uploading}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={save}>{org ? "Salvar" : "Criar"}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Posto Central Ltda." maxLength={120} error={touched ? nameError ?? undefined : undefined} autoFocus />
        {org && (
          <Input label="CNPJ" inputMode="numeric" value={cnpj} onChange={(e) => setCnpj(formatCnpj(e.target.value))} placeholder="00.000.000/0000-00" maxLength={18}
            error={(touched || cnpj.replace(/\D/g, "").length === 14) ? cnpjError ?? undefined : undefined} />
        )}
        {org && (
          <div className="flex items-center gap-3">
            <span className="w-14 h-14 rounded-(--radius-control) border border-(--border-default) bg-(--bg-hover) flex items-center justify-center overflow-hidden shrink-0">
              {logoUrl ? <img src={logoUrl} alt={`Logo de ${org.name}`} className="max-w-full max-h-full object-contain" /> : <ImageIcon className="w-5 h-5 text-(--text-secondary)" aria-hidden="true" />}
            </span>
            <div>
              <Button type="button" variant="secondary" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>{logoUrl ? "Trocar logo" : "Enviar logo"}</Button>
              <p className="mt-1 text-mac-caption text-(--text-secondary)">PNG, JPG, SVG ou WebP, até 2 MB. Aparece no topo e nos relatórios.</p>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="sr-only" tabIndex={-1}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }} />
            </div>
          </div>
        )}
        <button type="submit" className="sr-only">Salvar</button>
      </form>
      {/* Perfil fiscal desta empresa sem trocar a empresa no topo (A9-05);
          salva cada campo ao escolher, como na seção da empresa atual. */}
      {org && <div className="mt-4"><FiscalProfileSection companyId={org.id} companyName={org.name} isAdmin embedded /></div>}
    </Dialog>
  );
}

interface FiscalProfile {
  regime_tributario: string | null;
  faixa_funcionarios: string | null;
  uf: string | null;
  tipo_juridico: string | null;
  cnae_principal: string | null;
}

/** 4731800 → 4731-8/00 enquanto digita. */
function formatCnae(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 7);
  if (d.length <= 4) return d;
  if (d.length === 5) return `${d.slice(0, 4)}-${d[4]}`;
  return `${d.slice(0, 4)}-${d[4]}/${d.slice(5)}`;
}

const REGIME_LABEL: Record<string, string> = {
  simples_nacional: "Simples Nacional",
  lucro_presumido: "Lucro Presumido",
  lucro_real: "Lucro Real",
};
const FAIXA_LABEL: Record<string, string> = {
  nenhum: "Nenhum funcionário",
  "1_a_10": "1 a 10",
  "11_a_50": "11 a 50",
  "51_a_200": "51 a 200",
  "201_mais": "201 ou mais",
};
const TIPO_JURIDICO_LABEL: Record<string, string> = {
  mei: "MEI", ltda: "LTDA", sa: "S.A.", eireli: "EIRELI", outro: "Outro",
};
const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];

function FiscalProfileSection({ companyId, companyName, isAdmin, embedded = false }: { companyId: string; companyName: string; isAdmin: boolean; embedded?: boolean }) {
  const { error: showError } = useToast();
  const fpId = useId();
  const [profile, setProfile] = useState<FiscalProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<keyof FiscalProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [cnae, setCnae] = useState("");
  const [cnaeTocado, setCnaeTocado] = useState(false);

  function load() {
    setLoading(true);
    setFailed(false);
    api.get<FiscalProfile>(`/companies/${companyId}/fiscal-profile`)
      .then((r) => { setProfile(r.data); setCnae(formatCnae(r.data.cnae_principal ?? "")); setCnaeTocado(false); })
      .catch(() => { setProfile(null); setFailed(true); })
      .finally(() => setLoading(false));
  }

  useEffect(load, [companyId]);

  async function update(field: keyof FiscalProfile, value: string) {
    if (!profile) return;
    const next = { ...profile, [field]: value || null };
    setProfile(next);
    setSaving(field);
    try {
      await api.put(`/companies/${companyId}/fiscal-profile`, next);
      setSavedAt(new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível salvar o perfil fiscal.");
      load();
    } finally {
      setSaving(null);
    }
  }

  const cnaeDigitos = cnae.replace(/\D/g, "");
  const cnaeErro = cnaeDigitos.length > 0 && cnaeDigitos.length !== 7 ? "O CNAE tem 7 dígitos (ex.: 4731-8/00)." : null;
  function salvarCnae() {
    setCnaeTocado(true);
    if (!profile || cnaeErro || (profile.cnae_principal ?? "") === cnaeDigitos) return;
    update("cnae_principal", cnaeDigitos);
  }

  if (failed) {
    return (
      <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) flex flex-wrap items-center gap-3 px-5 py-4">
        <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar o perfil fiscal de {companyName}.</p>
        <Button variant="secondary" size="sm" onClick={load}>Tentar de novo</Button>
      </div>
    );
  }

  if (loading || !profile) {
    return <div className="h-32 bg-(--bg-card) border border-(--border-default) rounded-(--radius-panel) animate-pulse" />;
  }

  return (
    <div className={embedded ? "space-y-4 border-t border-(--border-default) pt-4" : "glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-5 space-y-4 border border-teal-500/20"}>
      <div className="flex items-center gap-2">
        <ScrollText className="w-4 h-4 text-(--text-accent) shrink-0" />
        <h2 className="text-mac-body font-semibold text-(--text-primary) truncate">
          Perfil fiscal <span className="text-(--text-tertiary) font-normal">de</span> {companyName}
        </h2>
      </div>
      <p className="text-mac-caption text-(--text-secondary)">
        Decide quais obrigações valem para esta empresa (ex.: o DAS só para o Simples). Em branco, nada fica escondido.
        <span className="sr-only" role="status" aria-live="polite">{savedAt ? `Salvo às ${savedAt}` : ""}</span>
        {savedAt && <span className="ml-1 text-(--text-success)">Salvo às {savedAt}.</span>}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label id={`${fpId}-regime_tributario`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Regime tributário</label>
          <Dropdown
            ariaLabelledby={`${fpId}-regime_tributario`}
            value={profile.regime_tributario ?? ""}
            onChange={(v) => update("regime_tributario", v)}
            placeholder="Não informado"
            disabled={!isAdmin || !!saving}
            options={[{ value: "", label: "Não informado" }, ...Object.entries(REGIME_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </div>
        <div>
          <label id={`${fpId}-faixa_funcionarios`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Quantidade de funcionários</label>
          <Dropdown
            ariaLabelledby={`${fpId}-faixa_funcionarios`}
            value={profile.faixa_funcionarios ?? ""}
            onChange={(v) => update("faixa_funcionarios", v)}
            placeholder="Não informado"
            disabled={!isAdmin || !!saving}
            options={[{ value: "", label: "Não informado" }, ...Object.entries(FAIXA_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </div>
        <div>
          <label id={`${fpId}-uf`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">UF</label>
          <Dropdown
            ariaLabelledby={`${fpId}-uf`}
            value={profile.uf ?? ""}
            onChange={(v) => update("uf", v)}
            placeholder="Não informado"
            disabled={!isAdmin || !!saving}
            options={[{ value: "", label: "Não informado" }, ...UFS.map((uf) => ({ value: uf, label: uf }))]}
          />
        </div>
        <div>
          <label id={`${fpId}-tipo_juridico`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Tipo jurídico</label>
          <Dropdown
            ariaLabelledby={`${fpId}-tipo_juridico`}
            value={profile.tipo_juridico ?? ""}
            onChange={(v) => update("tipo_juridico", v)}
            placeholder="Não informado"
            disabled={!isAdmin || !!saving}
            options={[{ value: "", label: "Não informado" }, ...Object.entries(TIPO_JURIDICO_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </div>
        <div className="sm:col-span-2">
          <Input
            label="Atividade principal (CNAE)"
            inputMode="numeric"
            placeholder="0000-0/00"
            value={cnae}
            maxLength={9}
            disabled={!isAdmin || !!saving}
            onChange={(e) => setCnae(formatCnae(e.target.value))}
            onBlur={salvarCnae}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); salvarCnae(); } }}
            error={cnaeTocado && cnaeErro ? cnaeErro : undefined}
          />
          <p className="mt-1 text-mac-caption text-(--text-secondary)">
            Está no cartão do CNPJ. Com ele, os modelos prontos de obrigações mostram o que vale para esta atividade (ex.: licenças de posto, DIMOB).
          </p>
        </div>
      </div>
    </div>
  );
}

/** Cor estável por nome, para empresas sem logo se distinguirem na lista. */
const ORG_TINTS = ["#0D9488", "#2563EB", "#7C3AED", "#DB2777", "#EA580C", "#65A30D", "#0891B2", "#B45309"];
function OrgIcon({ org }: { org: Org }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!org.logo_key) { setUrl(null); return; }
    let vivo = true;
    api.get(`/companies/${org.id}/logo-url`).then((r) => { if (vivo) setUrl(r.data.logo_url); }).catch(() => {});
    return () => { vivo = false; };
  }, [org.id, org.logo_key]);
  if (url) {
    return (
      <span className="w-9 h-9 rounded-(--radius-control) border border-(--border-default) bg-white flex items-center justify-center overflow-hidden shrink-0">
        <img src={url} alt="" className="max-w-full max-h-full object-contain" onError={() => setUrl(null)} />
      </span>
    );
  }
  const palavras = org.name.replace(/\b(ltda|me|epp|s\.?a\.?|eireli)\b\.?/gi, "").trim().split(/\s+/).filter(Boolean);
  const iniciais = ((palavras[0]?.[0] ?? "") + (palavras[1]?.[0] ?? "")).toUpperCase() || "?";
  let h = 0;
  for (const ch of org.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span aria-hidden="true" className="w-9 h-9 rounded-(--radius-control) flex items-center justify-center shrink-0 text-white text-mac-caption font-semibold"
      style={{ background: ORG_TINTS[h % ORG_TINTS.length] }}>
      {iniciais}
    </span>
  );
}

export default function Organization() {
  usePageTitle("Organização");
  const { user } = useAuthContext();
  const { reload: reloadCompanies, current } = useCompany();
  const { success, error: showError } = useToast();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Org | null | "new">(null);
  const [deactivating, setDeactivating] = useState<Org | null>(null);
  const [busy, setBusy] = useState(false);

  const isSupremo = user?.role === "supremo";
  const isCurrentAdmin = current?.permission_level === "admin" || current?.permission_level === "supremo";

  const [listFailed, setListFailed] = useState(false);
  function load() {
    setLoading(true);
    setListFailed(false);
    api.get<Org[]>("/companies/organizations")
      .then((r) => setOrgs(Array.isArray(r.data) ? r.data : []))
      .catch(() => setListFailed(true))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function toggleActive(org: Org) {
    setBusy(true);
    try {
      await api.patch(`/companies/${org.id}`, { is_active: !org.is_active });
      success(org.is_active ? `"${org.name}" desativada.` : `"${org.name}" reativada.`);
      setDeactivating(null);
      load();
      reloadCompanies();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível atualizar a empresa. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {current && <FiscalProfileSection companyId={current.id} companyName={current.name} isAdmin={isCurrentAdmin} />}
      {current && isCurrentAdmin && <TemplatesSection companyId={current.id} companyName={current.name} />}
      {current && isCurrentAdmin && <DataSection companyId={current.id} companyName={current.name} />}

      <div className="flex items-center justify-between gap-3 pt-1">
        <h2 className="text-mac-body font-semibold text-(--text-primary)">Todas as empresas da organização</h2>
        {isSupremo && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="w-3.5 h-3.5" />
            Nova empresa
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-14 bg-(--bg-card) border border-(--border-default) rounded-(--radius-control) animate-pulse" />)}
        </div>
      ) : listFailed ? (
        <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) flex flex-wrap items-center gap-3 px-5 py-4">
          <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar as empresas.</p>
          <Button variant="secondary" size="sm" onClick={load}>Tentar de novo</Button>
        </div>
      ) : orgs.length === 0 ? (
        <EmptyState title="Nenhuma empresa cadastrada" icon={<Building2 className="w-6 h-6" />} />
      ) : (
        <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden">
          <ul>
            {orgs.map((org) => (
              <li key={org.id} className="flex items-center gap-3 px-5 py-4 border-b border-(--border-default) last:border-0">
                <OrgIcon org={org} />
                <div className="flex-1 min-w-0">
                  <p className="text-mac-body font-medium text-(--text-primary) flex items-center gap-2 min-w-0">
                    <span className="truncate">{org.name}</span>
                    {current?.id === org.id && <Badge variant="teal">Atual</Badge>}
                  </p>
                  <p className="text-mac-caption text-(--text-secondary)">
                    {org.cnpj ? formatCnpj(org.cnpj) : "CNPJ não informado"} · {org.document_count} {Number(org.document_count) === 1 ? "documento" : "documentos"} · {org.user_count} {Number(org.user_count) === 1 ? "pessoa com acesso" : "pessoas com acesso"}
                  </p>
                </div>
                {!org.is_active && <Badge variant="default">Inativa</Badge>}
                {isSupremo && (
                  <button
                    onClick={() => setDeactivating(org)}
                    className="px-2.5 py-1 rounded-full text-mac-caption text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) transition-colors duration-fast"
                  >
                    {org.is_active ? "Desativar" : "Reativar"}
                  </button>
                )}
                {/* Seta de disclosure em vez de link "Editar" — padrão de
                    linha-clicável do System Settings/iOS (linha inteira leva
                    a mais detalhes, sem depender de hover pra parecer clicável). */}
                <button
                  onClick={() => setEditing(org)}
                  aria-label={`Editar ${org.name}`}
                  className="p-1.5 -mr-1.5 rounded-full text-(--text-tertiary) hover:bg-(--bg-hover) hover:text-(--text-primary) transition-colors duration-fast shrink-0"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing && (
        <OrgModal
          org={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => { load(); reloadCompanies(); }}
        />
      )}

      {deactivating && (
        <ConfirmModal
          title={`${deactivating.is_active ? "Desativar" : "Reativar"} "${deactivating.name}"?`}
          description={deactivating.is_active
            ? "A empresa fica oculta para os usuários, mas nada é excluído. Você pode reativá-la a qualquer momento."
            : "A empresa volta a ficar visível e acessível para os usuários com permissão."}
          confirmLabel={deactivating.is_active ? "Desativar" : "Reativar"}
          danger={deactivating.is_active}
          loading={busy}
          onConfirm={() => toggleActive(deactivating)}
          onClose={() => setDeactivating(null)}
        />
      )}
    </div>
  );
}
