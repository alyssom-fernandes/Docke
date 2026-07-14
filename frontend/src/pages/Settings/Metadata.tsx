import { useEffect, useRef, useState } from "react";
import { Tags, Plus, X, Archive, FolderTree, Copy, GripVertical, Trash2 } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/shared/EmptyState";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Switch from "@/components/ui/Switch";
import Dropdown from "@/components/ui/Dropdown";

// ─── Types ───────────────────────────────────────────────────────────────────

type FieldType = "texto" | "cpf" | "cnpj" | "data" | "competencia" | "numero" | "selecao";

interface CustomField {
  id: string;
  company_id: string;
  label: string;
  field_key: string;
  type: FieldType;
  format_config: Record<string, unknown>;
  archived_at: string | null;
}

interface FolderOption {
  id: string;
  name: string;
  path: string;
}

interface ResolvedField {
  custom_field_id: string;
  required: boolean;
  display_order: number;
  column_width: number | null;
  label: string;
  field_key: string;
  type: FieldType;
}

interface FolderFieldRule {
  id: string;
  custom_field_id: string;
  mode: "apply" | "exclude";
  required: boolean;
  display_order: number;
  label: string;
  field_key: string;
  type: FieldType;
}

const TYPE_LABEL: Record<FieldType, string> = {
  texto: "Texto",
  cpf: "CPF",
  cnpj: "CNPJ",
  data: "Data",
  competencia: "Competência (mês/ano)",
  numero: "Número",
  selecao: "Seleção",
};

function folderDepth(path: string) {
  return path.split(".").length;
}

// ─── Modal: novo campo ────────────────────────────────────────────────────────

function NewFieldModal({ companyId, onClose, onCreated }: { companyId: string; onClose: () => void; onCreated: () => void }) {
  const { success, error: showError } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("texto");
  const [decimals, setDecimals] = useState(2);
  const [optionsText, setOptionsText] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!label.trim()) return;
    setSaving(true);
    try {
      const format_config: Record<string, unknown> =
        type === "numero" ? { decimals } :
        type === "selecao" ? { options: optionsText.split(",").map((o) => o.trim()).filter(Boolean) } :
        {};
      await api.post("/custom-fields", { company_id: companyId, label: label.trim(), type, format_config });
      success("Campo criado.");
      onCreated();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar o campo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[420px]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Novo campo</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Nome do campo</label>
            <input
              type="text" autoFocus value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Ex.: Instituição financeira"
              className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          </div>
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Tipo de resposta</label>
            <Dropdown
              value={type}
              placeholder="Selecione…"
              onChange={(v) => setType(v as FieldType)}
              options={(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
            />
          </div>
          {type === "numero" && (
            <div>
              <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Casas decimais</label>
              <input
                type="number" min={0} max={6} value={decimals} onChange={(e) => setDecimals(Number(e.target.value))}
                className="w-24 h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
              />
            </div>
          )}
          {type === "selecao" && (
            <div>
              <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Opções (separadas por vírgula)</label>
              <input
                type="text" value={optionsText} onChange={(e) => setOptionsText(e.target.value)}
                placeholder="Ex.: Banco do Brasil, Itaú, Bradesco"
                className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" loading={saving} onClick={create} disabled={!label.trim()}>Criar campo</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal: copiar de outra empresa ───────────────────────────────────────────

function CopyFieldsModal({ companies, targetCompanyId, onClose, onCopied }: {
  companies: { id: string; name: string }[]; targetCompanyId: string; onClose: () => void; onCopied: () => void;
}) {
  const { success, error: showError } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);
  const [sourceId, setSourceId] = useState("");
  const [saving, setSaving] = useState(false);
  const options = companies.filter((c) => c.id !== targetCompanyId);

  async function copy() {
    if (!sourceId) return;
    setSaving(true);
    try {
      const { data } = await api.post("/custom-fields/copy", { source_company_id: sourceId, target_company_id: targetCompanyId });
      success(`${data.length} campo(s) copiado(s).`);
      onCopied();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível copiar os campos.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[400px]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Copiar campos de outra empresa</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-mac-caption text-[var(--text-tertiary)]">
            Copia só o catálogo (nome, tipo, formato). Campos com o mesmo nome já existentes aqui não são duplicados.
            A aplicação nas pastas não é copiada — as estruturas de pasta são diferentes entre empresas.
          </p>
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Empresa de origem</label>
            <Dropdown
              value={sourceId}
              placeholder="Selecione…"
              onChange={setSourceId}
              options={options.map((c) => ({ value: c.id, label: c.name }))}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" loading={saving} onClick={copy} disabled={!sourceId}>Copiar</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Aba: Catálogo ────────────────────────────────────────────────────────────

function CatalogTab({ companyId, companies }: { companyId: string; companies: { id: string; name: string }[] }) {
  const { success, error: showError } = useToast();
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const [archiving, setArchiving] = useState<CustomField | null>(null);

  function load() {
    setLoading(true);
    api.get<CustomField[]>("/custom-fields", { params: { company_id: companyId } })
      .then((r) => setFields(Array.isArray(r.data) ? r.data : []))
      .catch(() => setFields([]))
      .finally(() => setLoading(false));
  }

  useEffect(load, [companyId]);

  async function confirmArchive() {
    if (!archiving) return;
    try {
      await api.post(`/custom-fields/${archiving.id}/archive`);
      success("Campo arquivado.");
      load();
    } catch {
      showError("Erro ao arquivar campo.");
    } finally {
      setArchiving(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-mac-caption text-[var(--text-tertiary)]">
          Campos personalizados disponíveis para aplicar nas pastas (aba "Aplicação na árvore").
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="secondary" size="sm" onClick={() => setShowCopy(true)}>
            <Copy className="w-3.5 h-3.5" /> Copiar de outra empresa
          </Button>
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Plus className="w-3.5 h-3.5" /> Novo campo
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-12 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />)}
        </div>
      ) : fields.length === 0 ? (
        <EmptyState title="Nenhum campo personalizado ainda" description="Crie campos como CPF, competência ou instituição financeira." icon={<Tags className="w-6 h-6" />} />
      ) : (
        <ul className="border border-[var(--border-default)] rounded-[var(--radius-control)] divide-y divide-[var(--border-default)] overflow-hidden">
          {fields.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-mac-body text-[var(--text-primary)]">{f.label}</p>
                <p className="text-mac-caption text-[var(--text-tertiary)]">{f.field_key}</p>
              </div>
              <Badge variant="default">{TYPE_LABEL[f.type]}</Badge>
              <button
                onClick={() => setArchiving(f)}
                title="Arquivar campo"
                className="p-1.5 rounded-[6px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
              >
                <Archive className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {showNew && <NewFieldModal companyId={companyId} onClose={() => setShowNew(false)} onCreated={load} />}
      {showCopy && <CopyFieldsModal companies={companies} targetCompanyId={companyId} onClose={() => setShowCopy(false)} onCopied={load} />}
      {archiving && (
        <ConfirmModal
          title={`Arquivar "${archiving.label}"?`}
          description="O campo some do catálogo e das pastas onde está aplicado. Valores já preenchidos em documentos não são apagados."
          confirmLabel="Arquivar"
          danger
          onConfirm={confirmArchive}
          onClose={() => setArchiving(null)}
        />
      )}
    </div>
  );
}

// ─── Aba: Aplicação na árvore ─────────────────────────────────────────────────

function TreeTab({ companyId }: { companyId: string }) {
  const { success, error: showError } = useToast();
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [allFields, setAllFields] = useState<CustomField[]>([]);
  const [folderId, setFolderId] = useState("");
  const [resolved, setResolved] = useState<ResolvedField[]>([]);
  const [rules, setRules] = useState<FolderFieldRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [addFieldId, setAddFieldId] = useState("");
  const [removing, setRemoving] = useState<FolderFieldRule | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<FolderOption[]>("/folders", { params: { company_id: companyId, flat: true } }),
      api.get<CustomField[]>("/custom-fields", { params: { company_id: companyId } }),
    ]).then(([foldersRes, fieldsRes]) => {
      setFolders(Array.isArray(foldersRes.data) ? foldersRes.data : []);
      setAllFields(Array.isArray(fieldsRes.data) ? fieldsRes.data : []);
    }).catch(() => {
      setFolders([]);
      setAllFields([]);
      showError("Não foi possível carregar as pastas ou os campos.");
    });
  }, [companyId]);

  function load() {
    setLoading(true);
    const params = { company_id: companyId, ...(folderId ? { folder_id: folderId } : {}) };
    Promise.all([
      api.get<ResolvedField[]>("/folder-fields/resolved", { params }),
      api.get<FolderFieldRule[]>("/folder-fields/rules", { params }),
    ]).then(([resolvedRes, rulesRes]) => {
      setResolved(Array.isArray(resolvedRes.data) ? resolvedRes.data : []);
      setRules(Array.isArray(rulesRes.data) ? rulesRes.data : []);
    }).finally(() => setLoading(false));
  }

  useEffect(load, [companyId, folderId]);

  const ownFieldIds = new Set(rules.filter((r) => r.mode === "apply").map((r) => r.custom_field_id));
  const availableToAdd = allFields.filter((f) => !resolved.some((r) => r.custom_field_id === f.id));

  async function applyField(fieldId: string) {
    try {
      await api.put("/folder-fields", {
        company_id: companyId, folder_id: folderId || null, custom_field_id: fieldId,
        mode: "apply", required: false, display_order: rules.length,
      });
      success("Campo aplicado nesta pasta.");
      setAddFieldId("");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível aplicar o campo.");
    }
  }

  async function toggleRequired(rule: FolderFieldRule) {
    try {
      await api.put("/folder-fields", {
        company_id: companyId, folder_id: folderId || null, custom_field_id: rule.custom_field_id,
        mode: "apply", required: !rule.required, display_order: rule.display_order,
      });
      load();
    } catch {
      showError("Erro ao atualizar o campo.");
    }
  }

  async function excludeInherited(fieldId: string) {
    try {
      await api.put("/folder-fields", {
        company_id: companyId, folder_id: folderId || null, custom_field_id: fieldId,
        mode: "exclude", required: false, display_order: 0,
      });
      success("Herança removida nesta pasta.");
      load();
    } catch {
      showError("Erro ao remover herança.");
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    try {
      await api.delete(`/folder-fields/${removing.id}`, { params: { company_id: companyId } });
      success("Regra removida — volta a herdar do ancestral, se houver.");
      load();
    } catch {
      showError("Erro ao remover a regra.");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div>
      <div className="mb-4">
        <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Pasta</label>
        <Dropdown
          className="max-w-[400px]"
          value={folderId}
          placeholder="Empresa toda (raiz)"
          onChange={setFolderId}
          options={[
            { value: "", label: "Empresa toda (raiz)" },
            ...folders.map((f) => ({ value: f.id, label: f.name, depth: Math.max(0, folderDepth(f.path) - 1) })),
          ]}
        />
        <p className="text-mac-caption text-[var(--text-tertiary)] mt-1.5">
          Campos aplicados aqui valem para esta pasta e todas as subpastas, a não ser que uma subpasta tenha sua própria regra.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-12 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />)}
        </div>
      ) : (
        <>
          {resolved.length === 0 ? (
            <p className="text-mac-caption text-[var(--text-tertiary)] py-4">Nenhum campo aplicado nesta pasta ainda.</p>
          ) : (
            <ul className="border border-[var(--border-default)] rounded-[var(--radius-control)] divide-y divide-[var(--border-default)] overflow-hidden mb-4">
              {resolved.map((f) => {
                const isOwn = ownFieldIds.has(f.custom_field_id);
                const ownRule = rules.find((r) => r.custom_field_id === f.custom_field_id && r.mode === "apply");
                return (
                  <li key={f.custom_field_id} className="flex items-center gap-3 px-4 py-3">
                    <GripVertical className="w-4 h-4 text-[var(--text-placeholder)] flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-mac-body text-[var(--text-primary)]">{f.label}</p>
                      <p className="text-mac-caption text-[var(--text-tertiary)]">
                        {TYPE_LABEL[f.type]}{!isOwn && " · herdado"}
                      </p>
                    </div>
                    {isOwn && ownRule ? (
                      <>
                        <label className="flex items-center gap-1.5 text-mac-caption text-[var(--text-secondary)]">
                          Obrigatório
                          <Switch checked={ownRule.required} onChange={() => toggleRequired(ownRule)} label="Obrigatório" />
                        </label>
                        <button
                          onClick={() => setRemoving(ownRule)}
                          title="Remover desta pasta"
                          className="p-1.5 rounded-[6px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => excludeInherited(f.custom_field_id)}
                        className="text-mac-caption text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors duration-fast"
                      >
                        Não herdar aqui
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {availableToAdd.length > 0 && (
            <div className="flex items-center gap-2">
              <Dropdown
                className="flex-1 max-w-[300px]"
                value={addFieldId}
                placeholder="Aplicar um campo do catálogo…"
                onChange={setAddFieldId}
                options={availableToAdd.map((f) => ({ value: f.id, label: f.label }))}
              />
              <Button size="sm" variant="secondary" disabled={!addFieldId} onClick={() => applyField(addFieldId)}>
                <Plus className="w-3.5 h-3.5" /> Aplicar
              </Button>
            </div>
          )}
        </>
      )}

      {removing && (
        <ConfirmModal
          title={`Remover "${removing.label}" desta pasta?`}
          description="A pasta volta a herdar a configuração do ancestral mais próximo (se houver alguma)."
          confirmLabel="Remover"
          danger
          onConfirm={confirmRemove}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

// ─── Página ────────────────────────────────────────────────────────────────────

export default function Metadata() {
  usePageTitle("Metadados");
  const { current, companies } = useCompany();
  const [tab, setTab] = useState<"catalog" | "tree">("catalog");

  if (!current) return null;

  return (
    <div className="space-y-6">
      <h2 className="text-mac-callout font-semibold text-[var(--text-primary)]">Metadados</h2>

      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6">
        <div className="flex items-center gap-1 mb-6 border-b border-[var(--border-default)]">
          <button
            onClick={() => setTab("catalog")}
            className={`flex items-center gap-1.5 px-3 py-2 text-mac-body border-b-2 transition-colors duration-fast ${
              tab === "catalog" ? "border-teal-500 text-teal-500 font-medium" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            <Tags className="w-4 h-4" /> Catálogo
          </button>
          <button
            onClick={() => setTab("tree")}
            className={`flex items-center gap-1.5 px-3 py-2 text-mac-body border-b-2 transition-colors duration-fast ${
              tab === "tree" ? "border-teal-500 text-teal-500 font-medium" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            <FolderTree className="w-4 h-4" /> Aplicação na árvore
          </button>
        </div>

        {tab === "catalog" ? <CatalogTab companyId={current.id} companies={companies} /> : <TreeTab companyId={current.id} />}
      </div>
    </div>
  );
}
