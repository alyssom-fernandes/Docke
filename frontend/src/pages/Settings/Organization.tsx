import { useEffect, useRef, useState } from "react";
import { Building2, Plus, X, Image as ImageIcon } from "lucide-react";
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] shadow-modal modal-card w-full max-w-[560px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{org ? "Editar empresa" : "Nova empresa"}</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Nome</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Minha Empresa Ltda."
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">CNPJ</label>
            <input
              value={cnpj}
              onChange={(e) => setCnpj(formatCnpj(e.target.value))}
              placeholder="00.000.000/0000-00"
              maxLength={18}
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
          </div>
          {org && (
            <p className="text-xs text-[var(--text-tertiary)] flex items-center gap-1.5">
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
  );
}

export default function Organization() {
  usePageTitle("Organização");
  const { user } = useAuthContext();
  const { reload: reloadCompanies } = useCompany();
  const { success, error: showError } = useToast();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Org | null | "new">(null);
  const [deactivating, setDeactivating] = useState<Org | null>(null);
  const [busy, setBusy] = useState(false);

  const isSupremo = user?.role === "supremo";

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Organização</h2>
        {isSupremo && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="w-3.5 h-3.5" />
            Nova empresa
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] animate-pulse" />)}
        </div>
      ) : orgs.length === 0 ? (
        <EmptyState title="Nenhuma empresa cadastrada" icon={<Building2 className="w-6 h-6" />} />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
          <ul>
            {orgs.map((org) => (
              <li key={org.id} className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border-default)] last:border-0">
                <div className="w-9 h-9 rounded-[8px] bg-teal-600/10 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-4 h-4 text-teal-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">{org.name}</p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {org.cnpj ? formatCnpj(org.cnpj) : "CNPJ não informado"} · {org.document_count} documentos · {org.user_count} usuários
                  </p>
                </div>
                {!org.is_active && <Badge variant="default">Inativa</Badge>}
                <button onClick={() => setEditing(org)} className="text-xs text-teal-600 hover:underline">Editar</button>
                {isSupremo && (
                  <button
                    onClick={() => setDeactivating(org)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    {org.is_active ? "Desativar" : "Reativar"}
                  </button>
                )}
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
