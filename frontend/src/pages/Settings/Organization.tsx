import { useEffect, useRef, useState } from "react";
import { Building2, Plus, Image as ImageIcon, ChevronRight, ScrollText } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { useAuthContext } from "@/lib/AuthContext";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/shared/EmptyState";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Portal from "@/components/ui/Portal";
import Dropdown from "@/components/ui/Dropdown";

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
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  async function save() {
    if (!name.trim()) return;
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
      showError(e?.response?.data?.detail ?? "Erro ao salvar empresa.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Portal>
    <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[560px]">
        <div className="px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">{org ? "Editar empresa" : "Nova empresa"}</h2>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Nome</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Minha Empresa Ltda."
              className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          </div>
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">CNPJ</label>
            <input
              value={cnpj}
              onChange={(e) => setCnpj(formatCnpj(e.target.value))}
              placeholder="00.000.000/0000-00"
              maxLength={18}
              className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          </div>
          {org && (
            <p className="text-mac-caption text-[var(--text-tertiary)] flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5" />
              Upload de logo em breve — envie por aqui assim que disponível.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" loading={saving} onClick={save} disabled={!name.trim()}>
            {org ? "Salvar" : "Criar"}
          </Button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

interface FiscalProfile {
  regime_tributario: string | null;
  faixa_funcionarios: string | null;
  uf: string | null;
  tipo_juridico: string | null;
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

function FiscalProfileSection({ companyId, companyName, isAdmin }: { companyId: string; companyName: string; isAdmin: boolean }) {
  const { success, error: showError } = useToast();
  const [profile, setProfile] = useState<FiscalProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    api.get<FiscalProfile>(`/companies/${companyId}/fiscal-profile`)
      .then((r) => setProfile(r.data))
      .catch(() => setProfile({ regime_tributario: null, faixa_funcionarios: null, uf: null, tipo_juridico: null }))
      .finally(() => setLoading(false));
  }

  useEffect(load, [companyId]);

  async function update(field: keyof FiscalProfile, value: string) {
    if (!profile) return;
    const next = { ...profile, [field]: value || null };
    setProfile(next);
    setSaving(true);
    try {
      await api.put(`/companies/${companyId}/fiscal-profile`, next);
      success("Perfil fiscal atualizado.");
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível salvar o perfil fiscal.");
      load();
    } finally {
      setSaving(false);
    }
  }

  if (loading || !profile) {
    return <div className="h-32 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-panel)] animate-pulse" />;
  }

  return (
    <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-5 space-y-4 border border-teal-500/20">
      <div className="flex items-center gap-2">
        <ScrollText className="w-4 h-4 text-teal-500 flex-shrink-0" />
        <h2 className="text-mac-body font-semibold text-[var(--text-primary)] truncate">
          Perfil fiscal <span className="text-[var(--text-tertiary)] font-normal">de</span> {companyName}
        </h2>
      </div>
      <p className="text-mac-caption text-[var(--text-secondary)]">
        Específico desta empresa — cada empresa da organização tem o próprio perfil. Para editar outra, troque a empresa selecionada no topo da tela. Usado pelas regras condicionais de obrigações (ex.: empresas do Simples Nacional não precisam de ECD). Deixe em branco o que não souber agora — nenhuma obrigação fica escondida por falta de preenchimento.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Regime tributário</label>
          <Dropdown
            value={profile.regime_tributario ?? ""}
            onChange={(v) => update("regime_tributario", v)}
            placeholder="Não informado"
            disabled={!isAdmin || saving}
            options={[{ value: "", label: "Não informado" }, ...Object.entries(REGIME_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </div>
        <div>
          <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Quantidade de funcionários</label>
          <Dropdown
            value={profile.faixa_funcionarios ?? ""}
            onChange={(v) => update("faixa_funcionarios", v)}
            placeholder="Não informado"
            disabled={!isAdmin || saving}
            options={[{ value: "", label: "Não informado" }, ...Object.entries(FAIXA_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </div>
        <div>
          <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">UF</label>
          <Dropdown
            value={profile.uf ?? ""}
            onChange={(v) => update("uf", v)}
            placeholder="Não informado"
            disabled={!isAdmin || saving}
            options={[{ value: "", label: "Não informado" }, ...UFS.map((uf) => ({ value: uf, label: uf }))]}
          />
        </div>
        <div>
          <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Tipo jurídico</label>
          <Dropdown
            value={profile.tipo_juridico ?? ""}
            onChange={(v) => update("tipo_juridico", v)}
            placeholder="Não informado"
            disabled={!isAdmin || saving}
            options={[{ value: "", label: "Não informado" }, ...Object.entries(TIPO_JURIDICO_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </div>
      </div>
    </div>
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

  function load() {
    setLoading(true);
    api.get<Org[]>("/companies/organizations")
      .then((r) => setOrgs(Array.isArray(r.data) ? r.data : []))
      .catch(() => setOrgs([]))
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
      showError(e?.response?.data?.detail ?? "Erro ao atualizar empresa.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {current && <FiscalProfileSection companyId={current.id} companyName={current.name} isAdmin={isCurrentAdmin} />}

      <div className="flex items-center justify-between gap-3 pt-1">
        <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Todas as empresas da organização</h2>
        {isSupremo && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="w-3.5 h-3.5" />
            Nova empresa
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />)}
        </div>
      ) : orgs.length === 0 ? (
        <EmptyState title="Nenhuma empresa cadastrada" icon={<Building2 className="w-6 h-6" />} />
      ) : (
        <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
          <ul>
            {orgs.map((org) => (
              <li key={org.id} className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border-default)] last:border-0">
                <div className="w-9 h-9 rounded-[var(--radius-control)] bg-teal-500/10 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-4 h-4 text-teal-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-mac-body font-medium text-[var(--text-primary)] flex items-center gap-2 min-w-0">
                    <span className="truncate">{org.name}</span>
                    {current?.id === org.id && <Badge variant="teal">Atual</Badge>}
                  </p>
                  <p className="text-mac-caption text-[var(--text-secondary)]">
                    {org.cnpj ? formatCnpj(org.cnpj) : "CNPJ não informado"} · {org.document_count} documentos · {org.user_count} usuários
                  </p>
                </div>
                {!org.is_active && <Badge variant="default">Inativa</Badge>}
                {isSupremo && (
                  <button
                    onClick={() => setDeactivating(org)}
                    className="px-2.5 py-1 rounded-full text-mac-caption text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast"
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
                  className="p-1.5 -mr-1.5 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast flex-shrink-0"
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
