import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Tags, Plus, Archive, FolderTree, Copy, Trash2 } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Input from "@/components/ui/Input";
import Dialog from "@/components/ui/Dialog";
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
  condition_field_id: string | null;
  condition_value: string | null;
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
  default_value: string | null;
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
  default_value: string | null;
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

function NewFieldModal({ companyId, existingFields, onClose, onCreated }: {
  companyId: string; existingFields: CustomField[]; onClose: () => void; onCreated: () => void;
}) {
  const { success, error: showError } = useToast();

  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("texto");
  // Fase 6.4: "ilimitado" é o padrão — decimals só entra no format_config
  // quando o admin explicitamente desmarca e escolhe um número de casas.
  const [limitDecimals, setLimitDecimals] = useState(false);
  const [decimals, setDecimals] = useState(2);
  const [optionsText, setOptionsText] = useState("");
  // Fase 8.4: campos condicionais — só aparece no formulário do documento
  // quando o campo escolhido aqui tem exatamente o valor informado.
  const [conditionFieldId, setConditionFieldId] = useState("");
  const [conditionValue, setConditionValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!label.trim()) return;
    setSaving(true);
    try {
      const format_config: Record<string, unknown> =
        type === "numero" ? (limitDecimals ? { decimals } : {}) :
        type === "selecao" ? { options: optionsText.split(",").map((o) => o.trim()).filter(Boolean) } :
        {};
      await api.post("/custom-fields", {
        company_id: companyId, label: label.trim(), type, format_config,
        condition_field_id: conditionFieldId || null,
        condition_value: conditionFieldId ? conditionValue.trim() || null : null,
      });
      success("Campo criado.");
      onCreated();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar o campo.");
    } finally {
      setSaving(false);
    }
  }

  const conditionOptions = existingFields.find((f) => f.id === conditionFieldId) as any;
  const condOpts: string[] = conditionOptions?.type === "selecao" ? (conditionOptions?.format_config?.options ?? []) : [];
  return (
    <Dialog onClose={onClose} title="Novo campo" size="md" busy={saving}
      description="Um campo que os documentos preenchem (ex.: CNPJ do fornecedor, competência, banco)."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={create} disabled={!label.trim()}>Criar campo</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <Input label="Nome do campo" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: Instituição financeira" maxLength={80} autoFocus />
        <div>
          <label id="nf-tipo" className="block text-mac-body font-medium text-(--text-secondary) mb-1">Tipo de resposta</label>
          <Dropdown ariaLabelledby="nf-tipo" value={type} placeholder="Selecione…" onChange={(v) => setType(v as FieldType)}
            options={(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
          <p className="mt-1 text-mac-caption text-(--text-secondary)">CPF, CNPJ, data e competência são conferidos ao preencher.</p>
        </div>
        {type === "numero" && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-mac-body text-(--text-primary)">
              <Checkbox checked={limitDecimals} onChange={(e) => setLimitDecimals(e.target.checked)} /> Limitar casas decimais
            </label>
            {limitDecimals ? (
              <div className="w-28"><Input label="Casas" type="number" min={0} max={6} value={decimals} onChange={(e) => setDecimals(Number(e.target.value))} /></div>
            ) : (
              <p className="text-mac-caption text-(--text-secondary)">Sem limite: o número é guardado como digitado.</p>
            )}
          </div>
        )}
        {type === "selecao" && (
          <div>
            <Input label="Opções (separe por vírgula)" value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="Ex.: Banco do Brasil, Itaú, Bradesco" />
            {optionsText.trim() && (
              <ul aria-label="Prévia das opções" className="mt-2 flex flex-wrap gap-1.5">
                {optionsText.split(",").map((o) => o.trim()).filter(Boolean).map((o) => <li key={o} className="rounded-full bg-(--bg-hover) px-2.5 py-0.5 text-mac-caption text-(--text-primary)">{o}</li>)}
              </ul>
            )}
          </div>
        )}
        {existingFields.length > 0 && (
          <div className="pt-2 border-t border-(--border-default) space-y-2">
            <label id="nf-cond" className="block text-mac-body font-medium text-(--text-secondary)">Só mostrar quando (opcional)</label>
            <Dropdown ariaLabelledby="nf-cond" value={conditionFieldId} placeholder="Sempre mostrar" onChange={setConditionFieldId}
              options={[{ value: "", label: "Sempre mostrar" }, ...existingFields.map((f) => ({ value: f.id, label: f.label }))]} />
            {conditionFieldId && (condOpts.length > 0 ? (
              <Dropdown ariaLabel="Valor que mostra o campo" value={conditionValue} placeholder="for igual a…" onChange={setConditionValue}
                options={condOpts.map((o) => ({ value: o, label: o }))} />
            ) : (
              <Input aria-label="Valor que mostra o campo" value={conditionValue} onChange={(e) => setConditionValue(e.target.value)} placeholder="quando for igual a…" />
            ))}
          </div>
        )}
        <button type="submit" className="sr-only">Criar</button>
      </form>
    </Dialog>
  );
}

// ─── Modal: copiar de outra empresa ───────────────────────────────────────────

function CopyFieldsModal({ companies, targetCompanyId, onClose, onCopied }: {
  companies: { id: string; name: string }[]; targetCompanyId: string; onClose: () => void; onCopied: () => void;
}) {
  const { success, error: showError } = useToast();
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
    <Dialog onClose={onClose} title="Copiar campos de outra empresa" size="sm" busy={saving}
      description="Copia o catálogo (nome, tipo e opções). Campos com o mesmo nome não são duplicados; a aplicação nas pastas não vem junto."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={copy} disabled={!sourceId}>Copiar</Button></>}>
      <label id="cf-origem" className="block text-mac-body font-medium text-(--text-secondary) mb-1">Empresa de origem</label>
      <Dropdown ariaLabelledby="cf-origem" value={sourceId} placeholder="Selecione…" onChange={setSourceId} options={options.map((c) => ({ value: c.id, label: c.name }))} />
    </Dialog>
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
  const [deleting, setDeleting] = useState<CustomField | null>(null);
  const [failed, setFailed] = useState(false);
  const [archived, setArchived] = useState<CustomField[]>([]);
  const [renaming, setRenaming] = useState<CustomField | null>(null);
  const [newLabel, setNewLabel] = useState("");

  function load() {
    setLoading(true);
    setFailed(false);
    api.get<CustomField[]>("/custom-fields", { params: { company_id: companyId, include_archived: true } })
      .then((r) => {
        const all = Array.isArray(r.data) ? r.data : [];
        setFields(all.filter((f: any) => !f.archived_at));
        setArchived(all.filter((f: any) => f.archived_at));
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }

  async function rename() {
    if (!renaming || !newLabel.trim()) return;
    try {
      await api.patch(`/custom-fields/${renaming.id}`, { label: newLabel.trim() });
      success("Nome do campo atualizado.");
      setRenaming(null);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível renomear.");
    }
  }

  async function restore(f: CustomField) {
    try {
      await api.post(`/custom-fields/${f.id}/restore`);
      success(`“${f.label}” voltou ao catálogo e às pastas onde estava.`);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível reativar.");
    }
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

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.delete(`/custom-fields/${deleting.id}`);
      success(`"${deleting.label}" excluído.`);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Erro ao excluir campo.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div>
      {/* flex-col no mobile — em linha única (row) os dois botões com
          shrink-0 nunca cediam espaço, empurrando o parágrafo pra uma
          coluna estreitíssima e o botão "Novo campo" pra fora da tela
          (overflow horizontal real, com scrollbar lateral). */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-mac-caption text-(--text-tertiary)">
          Campos personalizados disponíveis para aplicar nas pastas (aba "Aplicação na árvore").
        </p>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0">
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
          {[0, 1, 2].map((i) => <div key={i} className="h-12 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" />)}
        </div>
      ) : failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-(--radius-control) border border-(--border-default) px-4 py-3">
          <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar os campos.</p>
          <Button variant="secondary" size="sm" onClick={load}>Tentar de novo</Button>
        </div>
      ) : fields.length === 0 ? (
        <EmptyState title="Nenhum campo personalizado ainda" description="Crie campos como CPF, competência ou instituição financeira." icon={<Tags className="w-6 h-6" />} />
      ) : (
        <ul className="border border-(--border-default) rounded-(--radius-control) divide-y divide-(--border-default) overflow-hidden">
          {fields.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <div className="flex-1 min-w-40">
                <p className="text-mac-body text-(--text-primary)">{f.label}</p>
                <p className="text-mac-caption text-(--text-secondary)">{TYPE_LABEL[f.type]}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setRenaming(f); setNewLabel(f.label); }} aria-label={`Renomear ${f.label}`}>Renomear</Button>
              <Button variant="ghost" size="sm" onClick={() => setArchiving(f)} aria-label={`Arquivar ${f.label}`}><Archive className="w-3.5 h-3.5" aria-hidden="true" /> Arquivar</Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(f)} aria-label={`Excluir ${f.label}`}><Trash2 className="w-3.5 h-3.5 text-(--text-danger)" aria-hidden="true" /> Excluir</Button>
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && !loading && !failed && (
        <details className="mt-3">
          <summary className="cursor-pointer text-mac-caption font-medium text-(--text-accent)">{archived.length} arquivado{archived.length > 1 ? "s" : ""}</summary>
          <ul className="mt-2 space-y-1">
            {archived.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-mac-body text-(--text-secondary)">
                <span className="flex-1">{f.label} · {TYPE_LABEL[f.type]}</span>
                <Button variant="ghost" size="sm" onClick={() => restore(f)}>Reativar</Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {renaming && (
        <Dialog onClose={() => setRenaming(null)} title={`Renomear “${renaming.label}”`} size="sm"
          description="O nome muda em todas as pastas e documentos; os valores já preenchidos continuam."
          footer={<><Button variant="secondary" onClick={() => setRenaming(null)}>Cancelar</Button><Button disabled={!newLabel.trim()} onClick={rename}>Salvar</Button></>}>
          <form onSubmit={(e) => { e.preventDefault(); rename(); }}>
            <Input label="Nome do campo" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={80} autoFocus />
          </form>
        </Dialog>
      )}

      {showNew && (
        <NewFieldModal
          companyId={companyId}
          existingFields={fields.filter((f) => !f.archived_at)}
          onClose={() => setShowNew(false)}
          onCreated={load}
        />
      )}
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
      {deleting && (
        <ConfirmModal
          title={`Excluir "${deleting.label}"?`}
          description="Exclusão de verdade e irreversível — só funciona se o campo nunca foi preenchido em nenhum documento. Se já foi usado, arquive em vez de excluir."
          confirmLabel="Excluir"
          danger
          requireTypedConfirmation
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// ─── Aba: Aplicação na árvore ─────────────────────────────────────────────────

function TreeTab({ companyId, initialFolderId }: { companyId: string; initialFolderId?: string }) {
  const { success, error: showError } = useToast();
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [allFields, setAllFields] = useState<CustomField[]>([]);
  const [folderId, setFolderId] = useState(initialFolderId ?? "");
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
        default_value: rule.default_value,
      });
      load();
    } catch {
      showError("Erro ao atualizar o campo.");
    }
  }

  // Fase 8.3: valor padrão herdado — pré-preenche o campo no formulário de
  // documento dentro desta pasta (ou de uma sub-pasta sem regra própria).
  async function saveDefaultValue(rule: FolderFieldRule, value: string) {
    const trimmed = value.trim();
    if (trimmed === (rule.default_value ?? "")) return;
    try {
      await api.put("/folder-fields", {
        company_id: companyId, folder_id: folderId || null, custom_field_id: rule.custom_field_id,
        mode: "apply", required: rule.required, display_order: rule.display_order,
        default_value: trimmed || null,
      });
      load();
    } catch {
      showError("Erro ao salvar o valor padrão.");
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
        <label className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Pasta</label>
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
        <p className="text-mac-caption text-(--text-tertiary) mt-1.5">
          Campos aplicados aqui valem para esta pasta e todas as subpastas, a não ser que uma subpasta tenha sua própria regra.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-12 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" />)}
        </div>
      ) : (
        <>
          {resolved.length === 0 ? (
            <p className="text-mac-caption text-(--text-tertiary) py-4">Nenhum campo aplicado nesta pasta ainda.</p>
          ) : (
            <ul className="border border-(--border-default) rounded-(--radius-control) divide-y divide-(--border-default) overflow-hidden mb-4">
              {resolved.map((f) => {
                const isOwn = ownFieldIds.has(f.custom_field_id);
                const ownRule = rules.find((r) => r.custom_field_id === f.custom_field_id && r.mode === "apply");
                return (
                  <li key={f.custom_field_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <div className="flex-1 min-w-40">
                      <p className="text-mac-body text-(--text-primary)">{f.label}</p>
                      <p className="text-mac-caption text-(--text-secondary)">
                        {TYPE_LABEL[f.type]}{!isOwn && ` · vem de ${(f as any).source_folder_name ?? "uma pasta acima"}`}{(f as any).required ? " · obrigatório" : ""}{(f as any).default_value ? ` · padrão “${(f as any).default_value}”` : ""}
                      </p>
                    </div>
                    {isOwn && ownRule ? (
                      <>
                        <input
                          type="text"
                          aria-label={`Valor padrão de ${f.label}`}
                          defaultValue={ownRule.default_value ?? ""}
                          placeholder="Valor padrão"
                          onBlur={(e) => saveDefaultValue(ownRule, e.target.value)}
                          className="w-32 h-8 px-2.5 text-mac-caption bg-(--bg-card) border border-(--border-default) rounded-[6px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-teal-500/70"
                        />
                        <label className="flex items-center gap-1.5 text-mac-caption text-(--text-secondary)">
                          Obrigatório
                          <Switch checked={ownRule.required} onChange={() => toggleRequired(ownRule)} label="Obrigatório" />
                        </label>
                        <button
                          onClick={() => setRemoving(ownRule)}
                          title="Remover desta pasta"
                          className="p-1.5 rounded-[6px] text-(--text-tertiary) hover:text-(--text-primary) hover:bg-(--bg-hover) transition-colors duration-fast"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => excludeInherited(f.custom_field_id)}
                        className="text-mac-caption text-(--text-tertiary) hover:text-(--text-primary) transition-colors duration-fast"
                      >
                        Não herdar aqui
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {rules.filter((r) => r.mode === "exclude").length > 0 && (
            <div className="mb-4 rounded-(--radius-control) border border-dashed border-(--border-control) p-3 space-y-1.5">
              <p className="text-mac-caption font-medium text-(--text-secondary)">Não herdados nesta pasta</p>
              <ul className="space-y-1">
                {rules.filter((r) => r.mode === "exclude").map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-mac-body text-(--text-primary)">
                    <span className="flex-1">{r.label}</span>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(r)}>Voltar a herdar</Button>
                  </li>
                ))}
              </ul>
            </div>
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
          title={removing.mode === "exclude" ? `Voltar a herdar "${removing.label}" aqui?` : `Remover "${removing.label}" desta pasta?`}
          description="A pasta volta a herdar a configuração do ancestral mais próximo (se houver alguma)."
          confirmLabel={removing.mode === "exclude" ? "Voltar a herdar" : "Remover"}
          danger={removing.mode !== "exclude"}
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
  // Fase 10.1: deep link vindo do menu de contexto da pasta em Documents.tsx
  // (/settings/metadata?tab=tree&folder=<id>) — abre já na aba certa com a
  // pasta pré-selecionada, em vez de forçar o usuário a navegar até lá.
  const [searchParams] = useSearchParams();
  const initialFolderId = searchParams.get("folder") ?? undefined;
  const [tab, setTab] = useState<"catalog" | "tree">(searchParams.get("tab") === "tree" ? "tree" : "catalog");
  const [, setSearchParams] = useSearchParams();
  function changeTab(t: "catalog" | "tree") {
    setTab(t);
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set("tab", t); return n; }, { replace: true });
  }

  if (!current) return null;

  return (
    <div>
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-6">
        {/* Controle segmentado (cápsula com o segmento ativo em destaque) —
            a Apple nunca usa abas sublinhadas de texto dentro de um painel
            de Settings, o padrão nativo é esse pill de segmentos. */}
        <div role="tablist" aria-label="Metadados" className="inline-flex items-center gap-0.5 p-1 mb-6 rounded-full bg-(--bg-hover)">
          <button
            role="tab"
            aria-selected={tab === "catalog"}
            onClick={() => changeTab("catalog")}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-mac-body transition-colors duration-fast ${
              tab === "catalog"
                ? "bg-(--bg-card) text-(--text-primary) font-medium shadow-xs"
                : "text-(--text-secondary) hover:text-(--text-primary)"
            }`}
          >
            <Tags className="w-4 h-4" /> Catálogo
          </button>
          <button
            role="tab"
            aria-selected={tab === "tree"}
            onClick={() => changeTab("tree")}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-mac-body transition-colors duration-fast ${
              tab === "tree"
                ? "bg-(--bg-card) text-(--text-primary) font-medium shadow-xs"
                : "text-(--text-secondary) hover:text-(--text-primary)"
            }`}
          >
            <FolderTree className="w-4 h-4" aria-hidden="true" /> Por pasta
          </button>
        </div>

        {tab === "catalog" ? <CatalogTab companyId={current.id} companies={companies} /> : <TreeTab companyId={current.id} initialFolderId={initialFolderId} />}
      </div>
    </div>
  );
}
