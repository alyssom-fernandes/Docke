import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Tags, Plus, Archive, FolderTree, Copy, Trash2, X, ArrowUp, ArrowDown, Search } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { friendlyError } from "@/lib/errors";
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

type FieldType = "texto" | "cpf" | "cnpj" | "data" | "competencia" | "numero" | "selecao" | "moeda" | "email" | "telefone" | "cep" | "booleano"
  | "texto_longo" | "data_hora" | "multipla" | "url";

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
  moeda: "Valor em reais",
  selecao: "Seleção (lista de opções)",
  booleano: "Sim ou não",
  email: "E-mail",
  telefone: "Telefone",
  cep: "CEP",
  texto_longo: "Texto longo (observações)",
  data_hora: "Data e hora",
  multipla: "Múltipla escolha",
  url: "Endereço de site (URL)",
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
  const [options, setOptions] = useState<string[]>([]);
  const [optionDraft, setOptionDraft] = useState("");
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
        type === "selecao" || type === "multipla" ? { options: [...options, ...(optionDraft.trim() ? [optionDraft.trim()] : [])] } :
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
          <p className="mt-1 text-mac-caption text-(--text-secondary)">CPF, CNPJ, data, competência, valor, e-mail, telefone e CEP são conferidos ao preencher.</p>
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
        {(type === "selecao" || type === "multipla") && (
          <OptionsEditor options={options} setOptions={setOptions} draft={optionDraft} setDraft={setOptionDraft} />
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

/**
 * Opções da seleção como lista (A8-26): uma por linha, Enter acrescenta,
 * vírgula colada vira várias, setas reordenam e o X tira. Antes era um texto
 * com vírgulas, que quebrava opções como "Itaú, agência 10".
 */
function OptionsEditor({ options, setOptions, draft, setDraft }: {
  options: string[]; setOptions: (o: string[]) => void; draft: string; setDraft: (s: string) => void;
}) {
  const [erro, setErro] = useState<string | null>(null);
  function add(raw: string) {
    const novas = raw.split(/\n/).map((o) => o.trim()).filter(Boolean);
    if (!novas.length) return;
    const repetida = novas.find((n) => options.some((o) => o.toLowerCase() === n.toLowerCase()));
    if (repetida) { setErro(`“${repetida}” já está na lista.`); return; }
    setErro(null);
    setOptions([...options, ...novas]);
    setDraft("");
  }
  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= options.length) return;
    const n = [...options];
    [n[i], n[j]] = [n[j], n[i]];
    setOptions(n);
  }
  const btn = "h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) disabled:opacity-(--opacity-disabled)";
  return (
    <div>
      <label htmlFor="nf-opcao" className="block text-mac-body font-medium text-(--text-secondary) mb-1">Opções</label>
      {options.length > 0 && (
        <ol aria-label="Opções da lista" className="mb-2 rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)">
          {options.map((o, i) => (
            <li key={o} className="flex items-center gap-1 pl-3 pr-1 py-0.5 text-mac-body text-(--text-primary)">
              <span className="flex-1 min-w-0 truncate">{o}</span>
              <button type="button" className={btn} onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Subir ${o}`}><ArrowUp className="w-3.5 h-3.5" aria-hidden /></button>
              <button type="button" className={btn} onClick={() => move(i, 1)} disabled={i === options.length - 1} aria-label={`Descer ${o}`}><ArrowDown className="w-3.5 h-3.5" aria-hidden /></button>
              <button type="button" className={btn} onClick={() => setOptions(options.filter((_, k) => k !== i))} aria-label={`Tirar ${o}`}><X className="w-3.5 h-3.5" aria-hidden /></button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex gap-2">
        <input id="nf-opcao" value={draft} onChange={(e) => { setDraft(e.target.value); setErro(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft); } }}
          onPaste={(e) => { const t = e.clipboardData.getData("text"); if (t.includes("\n")) { e.preventDefault(); add(t); } }}
          placeholder={options.length ? "Outra opção" : "Ex.: Banco do Brasil"} maxLength={120}
          className="mac-field flex-1 min-w-0 h-8 pointer-coarse:h-11 px-3 text-mac-body text-(--text-primary)" aria-describedby="nf-opcao-ajuda" />
        <Button type="button" variant="secondary" size="sm" onClick={() => add(draft)} disabled={!draft.trim()}><Plus className="w-3.5 h-3.5" aria-hidden /> Acrescentar</Button>
      </div>
      <p id="nf-opcao-ajuda" className={`mt-1 text-mac-caption ${erro ? "text-(--text-danger)" : "text-(--text-secondary)"}`} role={erro ? "alert" : undefined}>
        {erro ?? "Enter acrescenta. Colar uma lista (uma por linha) acrescenta todas."}
      </p>
    </div>
  );
}

// ─── Modal: copiar de outra empresa ───────────────────────────────────────────

interface CopyPreviewRow { id: string; label: string; type: string; existe: boolean; aplicacoes: number; aplicacoes_com_pasta: number }
interface CopyReport { criados: string[]; existentes: string[]; aplicacoes_copiadas: number; aplicacoes_sem_pasta: number }

// Copiar campos de outra empresa (A8-28): só empresas que a pessoa administra,
// prévia de cada campo (novo ou já existente), escolha de quais levar, opção de
// levar a aplicação nas pastas de mesmo nome e relatório no fim.
function CopyFieldsModal({ companies, targetCompanyId, onClose, onCopied }: {
  companies: { id: string; name: string; permission_level?: string }[]; targetCompanyId: string; onClose: () => void; onCopied: () => void;
}) {
  const { error: showError } = useToast();
  const [sourceId, setSourceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<CopyPreviewRow[] | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [includeTree, setIncludeTree] = useState(true);
  const [report, setReport] = useState<CopyReport | null>(null);
  const options = companies.filter((c) => c.id !== targetCompanyId && (c.permission_level === "admin" || c.permission_level === "supremo"));

  useEffect(() => {
    if (!sourceId) { setPreview(null); return; }
    let vivo = true;
    setPreview(null);
    setPreviewFailed(false);
    api.post<CopyPreviewRow[]>("/custom-fields/copy/preview", { source_company_id: sourceId, target_company_id: targetCompanyId })
      .then((r) => { if (!vivo) return; setPreview(r.data); setSel(new Set(r.data.filter((c) => !c.existe).map((c) => c.id))); })
      .catch(() => { if (vivo) setPreviewFailed(true); });
    return () => { vivo = false; };
  }, [sourceId, targetCompanyId]);

  async function copy() {
    if (!sourceId || !sel.size) return;
    setSaving(true);
    try {
      const { data } = await api.post<CopyReport>("/custom-fields/copy-selected", {
        source_company_id: sourceId, target_company_id: targetCompanyId, field_ids: [...sel], include_tree: includeTree,
      });
      setReport(data);
      onCopied();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível copiar os campos. Tente de novo.");
    } finally {
      setSaving(false);
    }
  }

  if (report) {
    return (
      <Dialog onClose={onClose} title="Campos copiados" size="sm"
        footer={<Button onClick={onClose}>Concluir</Button>}>
        <ul className="space-y-1.5 text-mac-body text-(--text-primary)" role="status">
          <li>{report.criados.length ? `${report.criados.length} campo(s) novo(s): ${report.criados.join(", ")}.` : "Nenhum campo novo."}</li>
          {report.existentes.length > 0 && <li className="text-(--text-secondary)">Já existiam e foram reaproveitados: {report.existentes.join(", ")}.</li>}
          {includeTree && <li>{report.aplicacoes_copiadas} aplicação(ões) em pasta copiadas.</li>}
          {report.aplicacoes_sem_pasta > 0 && (
            <li className="text-(--text-warning)">{report.aplicacoes_sem_pasta} aplicação(ões) ficaram de fora porque não há pasta com o mesmo caminho nesta empresa. Aplique pela aba “Aplicação na árvore”.</li>
          )}
        </ul>
      </Dialog>
    );
  }

  const todos = preview ?? [];
  return (
    <Dialog onClose={onClose} title="Copiar campos de outra empresa" size="md" busy={saving}
      description="Escolha os campos. Campo com o mesmo nome no destino é reaproveitado, nunca duplicado."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={copy} disabled={!sourceId || !sel.size}>{sel.size ? `Copiar ${sel.size}` : "Copiar"}</Button></>}>
      <div className="space-y-4">
        <div>
          <label id="cf-origem" className="block text-mac-body font-medium text-(--text-secondary) mb-1">Empresa de origem</label>
          {options.length ? (
            <Dropdown ariaLabelledby="cf-origem" value={sourceId} placeholder="Selecione…" onChange={setSourceId} options={options.map((c) => ({ value: c.id, label: c.name }))} />
          ) : (
            <p className="text-mac-caption text-(--text-secondary)">Você não administra outra empresa para copiar campos.</p>
          )}
        </div>
        {sourceId && (
          previewFailed ? (
            <p role="alert" className="text-mac-caption text-(--text-danger)">Não foi possível ler os campos dessa empresa. Tente de novo.</p>
          ) : !preview ? (
            <div className="space-y-1.5" aria-label="Carregando campos">{[0, 1, 2].map((k) => <div key={k} className="h-8 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>
          ) : todos.length === 0 ? (
            <p className="text-mac-caption text-(--text-secondary)">Essa empresa não tem campos ativos.</p>
          ) : (
            <fieldset>
              <legend className="text-mac-caption font-medium text-(--text-secondary) mb-1">Campos ({sel.size} de {todos.length})</legend>
              <ul className="max-h-[240px] overflow-y-auto rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)">
                {todos.map((c) => (
                  <li key={c.id}>
                    <label className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-(--bg-hover)">
                      <Checkbox checked={sel.has(c.id)} onChange={() => setSel((prev) => { const n = new Set(prev); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-mac-body text-(--text-primary)">{c.label}</span>
                        <span className="block text-mac-caption text-(--text-secondary)">
                          {TYPE_LABEL[c.type as keyof typeof TYPE_LABEL] ?? c.type}
                          {c.existe ? " · já existe aqui (será reaproveitado)" : " · novo"}
                          {c.aplicacoes ? ` · ${c.aplicacoes_com_pasta} de ${c.aplicacoes} aplicação(ões) com pasta equivalente` : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )
        )}
        <label className="flex items-start gap-2 text-mac-body text-(--text-primary) cursor-pointer">
          <Checkbox checked={includeTree} onChange={(e) => setIncludeTree(e.target.checked)} />
          <span>Levar também a aplicação nas pastas de mesmo nome (ex.: “Fiscal / Notas”)</span>
        </label>
      </div>
    </Dialog>
  );
}

// Copiar as regras da pasta aberta para outra pasta da mesma empresa (A8-28).
function CopyRulesModal({ companyId, sourceFolder, folders, onClose, onCopied }: {
  companyId: string; sourceFolder: FolderOption; folders: FolderOption[]; onClose: () => void; onCopied: () => void;
}) {
  const { success, error: showError } = useToast();
  const [targetId, setTargetId] = useState("");
  const [saving, setSaving] = useState(false);
  async function copy() {
    if (!targetId) return;
    setSaving(true);
    try {
      const { data } = await api.post("/folder-fields/copy", { company_id: companyId, source_folder_id: sourceFolder.id, target_folder_id: targetId });
      success(`${data.regras_copiadas} regra(s) copiada(s) para “${data.destino}”.`);
      onCopied();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível copiar as regras. Tente de novo.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog onClose={onClose} title={`Copiar regras de “${sourceFolder.name}”`} size="sm" busy={saving}
      description="Os campos aplicados (e os não herdados) desta pasta passam a valer também na pasta escolhida. Regras do destino para os mesmos campos são substituídas."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={copy} disabled={!targetId}>Copiar regras</Button></>}>
      <label id="cr-destino" className="block text-mac-body font-medium text-(--text-secondary) mb-1">Pasta de destino</label>
      <Dropdown ariaLabelledby="cr-destino" value={targetId} placeholder="Selecione…" onChange={setTargetId}
        options={folders.filter((f) => f.id !== sourceFolder.id).map((f) => ({ value: f.id, label: f.name, depth: Math.max(0, folderDepth(f.path) - 1) }))} />
    </Dialog>
  );
}

// ─── Aba: Catálogo ────────────────────────────────────────────────────────────

function CatalogTab({ companyId, companies }: { companyId: string; companies: { id: string; name: string; permission_level?: string }[] }) {
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
  // Onde cada campo vale (A8-13): regras do campo na árvore, sob demanda.
  const [ondeVale, setOndeVale] = useState<{ id: string; dados: { regras: { folder_path: string | null; mode: string; required: boolean; default_value: string | null; caminho: string }[]; documentos_com_valor: number } | null } | null>(null);
  useEffect(() => {
    if (!ondeVale || ondeVale.dados) return;
    api.get(`/custom-fields/${ondeVale.id}/where`).then((r) => setOndeVale((o) => (o && o.id === ondeVale.id ? { ...o, dados: r.data } : o))).catch(() => setOndeVale(null));
  }, [ondeVale]);
  const [applying, setApplying] = useState<CustomField | null>(null);
  const [retyping, setRetyping] = useState<CustomField | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [busca, setBusca] = useState("");
  const dobra = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const visiveis = busca.trim() ? fields.filter((f) => dobra(`${f.label} ${TYPE_LABEL[f.type]}`).includes(dobra(busca.trim()))) : fields;

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
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível arquivar o campo. Tente de novo."));
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
      showError(friendlyError(e, "Não foi possível excluir o campo. Se ele já foi preenchido em algum documento, arquive em vez de excluir."));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="@container">
      {/* A linha depende da largura do cartão, não da janela (A8-17): em
          768 px o cartão tem ~410 px e a linha única empurrava "Novo campo"
          para fora. Só fica em linha quando o cartão tem espaço (@2xl). */}
      <div className="flex flex-col @2xl:flex-row @2xl:items-center @2xl:justify-between gap-3 mb-4">
        <p className="text-mac-caption text-(--text-tertiary)">
          Campos que os documentos preenchem. Escolha onde cada um vale em “Aplicar em pastas…” ou na aba Por pasta.
        </p>
        <div className="flex flex-col @sm:flex-row items-stretch @sm:items-center gap-2 shrink-0">
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
        <>
        {fields.length >= 6 && (
          <div className="relative mb-3 max-w-[320px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-secondary)" aria-hidden />
            <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={`Buscar entre ${fields.length} campos`} aria-label="Buscar campo"
              className="mac-field w-full h-8 pointer-coarse:h-11 pl-8 pr-3 text-mac-body text-(--text-primary)" />
          </div>
        )}
        {visiveis.length === 0 && <p className="py-4 text-mac-body text-(--text-secondary)">Nenhum campo com “{busca}”.</p>}
        <ul className="border border-(--border-default) rounded-(--radius-control) divide-y divide-(--border-default) overflow-hidden empty:hidden">
          {visiveis.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <div className="flex-1 min-w-40">
                <p className="text-mac-body text-(--text-primary)">{f.label}</p>
                <p className="text-mac-caption text-(--text-secondary)">{TYPE_LABEL[f.type]}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setOndeVale(ondeVale?.id === f.id ? null : { id: f.id, dados: null })} aria-expanded={ondeVale?.id === f.id} aria-label={`Onde ${f.label} vale`}>Onde vale</Button>
              <Button variant="ghost" size="sm" onClick={() => setApplying(f)} aria-label={`Aplicar ${f.label} em pastas`}>Aplicar em pastas…</Button>
              <Button variant="ghost" size="sm" onClick={() => { setRenaming(f); setNewLabel(f.label); }} aria-label={`Renomear ${f.label}`}>Renomear</Button>
              <Button variant="ghost" size="sm" onClick={() => setRetyping(f)} aria-label={`Trocar o tipo de ${f.label}`}>Trocar tipo…</Button>
              <Button variant="ghost" size="sm" onClick={() => setArchiving(f)} aria-label={`Arquivar ${f.label}`}><Archive className="w-3.5 h-3.5" aria-hidden="true" /> Arquivar</Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(f)} aria-label={`Excluir ${f.label}`}><Trash2 className="w-3.5 h-3.5 text-(--text-danger)" aria-hidden="true" /> Excluir</Button>
              {ondeVale?.id === f.id && (
                <div className="basis-full mt-1 rounded-(--radius-control) bg-(--bg-hover) px-3 py-2 text-mac-caption" role="region" aria-label={`Onde ${f.label} vale`}>
                  {!ondeVale.dados ? <span className="text-(--text-secondary)">Carregando…</span> : ondeVale.dados.regras.length === 0 ? (
                    <span className="text-(--text-secondary)">Ainda não está aplicado em nenhuma pasta.</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {ondeVale.dados.regras.map((r, i) => (
                        <li key={i} className="text-(--text-primary)">
                          {r.mode === "exclude" ? "Não vale em " : ""}<strong className="font-medium">{r.caminho}</strong>{r.folder_path ? " e subpastas" : ""}
                          {r.mode !== "exclude" && <span className="text-(--text-secondary)">{r.required ? " · obrigatório" : " · opcional"}{r.default_value ? ` · padrão “${r.default_value}”` : ""}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {ondeVale.dados && <p className="mt-1 text-(--text-secondary)">{ondeVale.dados.documentos_com_valor} {ondeVale.dados.documentos_com_valor === 1 ? "documento já tem" : "documentos já têm"} valor.</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
        </>
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

      {applying && <ApplyFieldDialog companyId={companyId} field={applying} onClose={() => setApplying(null)} />}
      {retyping && <ChangeTypeDialog field={retyping} onClose={() => setRetyping(null)} onDone={() => { setRetyping(null); load(); }} />}

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

function TreeTab({ companyId, initialFolderId, onGoCatalog }: { companyId: string; initialFolderId?: string; onGoCatalog: () => void }) {
  const [applyingDefault, setApplyingDefault] = useState<{ rule: FolderFieldRule; label: string } | null>(null);
  const { success, error: showError } = useToast();
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [allFields, setAllFields] = useState<CustomField[]>([]);
  const [folderId, setFolderId] = useState(initialFolderId ?? "");
  const [resolved, setResolved] = useState<ResolvedField[]>([]);
  const [rules, setRules] = useState<FolderFieldRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [addFieldId, setAddFieldId] = useState("");
  const [removing, setRemoving] = useState<FolderFieldRule | null>(null);
  const [copyingRules, setCopyingRules] = useState(false);

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
      showError("Não foi possível carregar as pastas ou os campos. Recarregue a página para tentar de novo.");
    });
  }, [companyId]);

  // Só a troca de pasta mostra o esqueleto; depois de uma ação a lista é
  // atualizada no lugar, sem piscar (A8-15).
  function load(silencioso = false) {
    if (!silencioso) setLoading(true);
    const params = { company_id: companyId, ...(folderId ? { folder_id: folderId } : {}) };
    Promise.all([
      api.get<ResolvedField[]>("/folder-fields/resolved", { params }),
      api.get<FolderFieldRule[]>("/folder-fields/rules", { params }),
    ]).then(([resolvedRes, rulesRes]) => {
      setResolved(Array.isArray(resolvedRes.data) ? resolvedRes.data : []);
      setRules(Array.isArray(rulesRes.data) ? rulesRes.data : []);
    }).finally(() => setLoading(false));
  }

  useEffect(() => load(), [companyId, folderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => load(true);

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
      reload();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível aplicar o campo.");
    }
  }

  // Ordem dos campos no formulário do documento (A8-22): troca a posição com
  // o vizinho entre os campos definidos nesta pasta.
  async function move(rule: FolderFieldRule, d: -1 | 1) {
    const own = rules.filter((r) => r.mode === "apply").sort((a, b) => a.display_order - b.display_order);
    const i = own.findIndex((r) => r.id === rule.id);
    const other = own[i + d];
    if (!other) return;
    const put = (r: FolderFieldRule, order: number) => api.put("/folder-fields", {
      company_id: companyId, folder_id: folderId || null, custom_field_id: r.custom_field_id,
      mode: "apply", required: r.required, display_order: order, default_value: r.default_value,
    });
    // Ordens iguais (regras antigas) ganham posições distintas antes da troca.
    const a = i, b = i + d;
    try {
      await Promise.all(own.map((r, k) => (k === a ? put(r, b) : k === b ? put(r, a) : r.display_order !== k ? put(r, k) : null)).filter(Boolean));
      reload();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível mudar a ordem. Tente de novo."));
    }
  }

  async function toggleRequired(rule: FolderFieldRule) {
    // Otimista: o interruptor responde na hora e volta se o servidor recusar.
    setRules((p) => p.map((r) => (r.id === rule.id ? { ...r, required: !rule.required } : r)));
    try {
      await api.put("/folder-fields", {
        company_id: companyId, folder_id: folderId || null, custom_field_id: rule.custom_field_id,
        mode: "apply", required: !rule.required, display_order: rule.display_order,
        default_value: rule.default_value,
      });
      reload();
    } catch (e: any) {
      setRules((p) => p.map((r) => (r.id === rule.id ? { ...r, required: rule.required } : r)));
      showError(friendlyError(e, "Não foi possível atualizar o campo. Tente de novo."));
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
      success(trimmed ? `Padrão de "${rule.label}" salvo: novos documentos desta pasta já vêm com ele.` : `Padrão de "${rule.label}" retirado.`);
      reload();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível salvar o valor padrão. Confira o formato do campo e tente de novo."));
    }
  }

  async function excludeInherited(fieldId: string) {
    try {
      await api.put("/folder-fields", {
        company_id: companyId, folder_id: folderId || null, custom_field_id: fieldId,
        mode: "exclude", required: false, display_order: 0,
      });
      success("Herança removida nesta pasta.");
      reload();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível deixar de herdar o campo aqui. Tente de novo."));
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    try {
      await api.delete(`/folder-fields/${removing.id}`, { params: { company_id: companyId } });
      success("Regra removida — volta a herdar do ancestral, se houver.");
      reload();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível remover a regra. Tente de novo."));
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
        {folderId && rules.length > 0 && (
          <Button variant="ghost" size="sm" className="mt-1.5" onClick={() => setCopyingRules(true)}>
            <Copy className="w-3.5 h-3.5" aria-hidden /> Copiar as regras desta pasta para outra…
          </Button>
        )}
        {copyingRules && folders.find((f) => f.id === folderId) && (
          <CopyRulesModal companyId={companyId} sourceFolder={folders.find((f) => f.id === folderId)!} folders={folders}
            onClose={() => setCopyingRules(false)} onCopied={reload} />
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-12 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" />)}
        </div>
      ) : (
        <>
          {allFields.length === 0 ? (
            <div className="rounded-(--radius-control) border border-dashed border-(--border-control) px-4 py-5 text-center space-y-2">
              <p className="text-mac-body text-(--text-primary)">Ainda não há campos no catálogo.</p>
              <p className="text-mac-caption text-(--text-secondary)">Crie o campo uma vez (ex.: CNPJ do fornecedor) e depois escolha em quais pastas ele vale.</p>
              <Button size="sm" onClick={onGoCatalog}><Plus className="w-3.5 h-3.5" aria-hidden /> Criar o primeiro campo</Button>
            </div>
          ) : resolved.length === 0 ? (
            <p className="text-mac-caption text-(--text-tertiary) py-4">Nenhum campo aplicado nesta pasta ainda. Escolha um do catálogo abaixo.</p>
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
                        <span className="inline-flex">
                          <button type="button" onClick={() => move(ownRule, -1)} aria-label={`Subir ${f.label}`} title="Subir no formulário"
                            className="h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><ArrowUp className="w-3.5 h-3.5" aria-hidden /></button>
                          <button type="button" onClick={() => move(ownRule, 1)} aria-label={`Descer ${f.label}`} title="Descer no formulário"
                            className="h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><ArrowDown className="w-3.5 h-3.5" aria-hidden /></button>
                        </span>
                        <input
                          type="text"
                          aria-label={`Valor padrão de ${f.label}`}
                          defaultValue={ownRule.default_value ?? ""}
                          placeholder="Valor padrão"
                          onBlur={(e) => saveDefaultValue(ownRule, e.target.value)}
                          className="w-32 h-8 px-2.5 text-mac-caption bg-(--bg-card) border border-(--border-default) rounded-(--radius-control) text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-teal-500/70"
                        />
                        {ownRule.default_value && (
                          <Button variant="ghost" size="sm" onClick={() => setApplyingDefault({ rule: ownRule, label: f.label })}>Aplicar aos existentes…</Button>
                        )}
                        <label className="flex items-center gap-1.5 text-mac-caption text-(--text-secondary)">
                          Obrigatório
                          <Switch checked={ownRule.required} onChange={() => toggleRequired(ownRule)} label="Obrigatório" />
                        </label>
                        <button
                          onClick={() => setRemoving(ownRule)}
                          title="Remover desta pasta"
                          className="p-1.5 rounded-(--radius-control) text-(--text-tertiary) hover:text-(--text-primary) hover:bg-(--bg-hover) transition-colors duration-fast"
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

      {applyingDefault && <ApplyDefaultDialog rule={applyingDefault.rule} label={applyingDefault.label} onClose={() => { setApplyingDefault(null); reload(); }} />}
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

/**
 * Matriz campo × pasta (FA-A8-07): cada pasta numa linha, cada campo numa
 * coluna, com o que vale ali (próprio ou herdado, obrigatório ou opcional, ou
 * desligado). Clicar na pasta abre a configuração dela na aba Por pasta.
 */
function MatrixTab({ companyId, onOpenFolder }: { companyId: string; onOpenFolder: (folderId: string) => void }) {
  type Regra = { folder_path: string | null; mode: string; required: boolean; folder_id: string | null };
  const [dados, setDados] = useState<{ folders: FolderOption[]; fields: CustomField[]; regras: Record<string, Regra[]> } | null>(null);
  const [falhou, setFalhou] = useState(false);
  useEffect(() => {
    setDados(null); setFalhou(false);
    Promise.all([
      api.get<FolderOption[]>("/folders", { params: { company_id: companyId, flat: true } }),
      api.get<CustomField[]>("/custom-fields", { params: { company_id: companyId } }),
    ]).then(async ([fo, fi]) => {
      const fields = (fi.data ?? []).slice(0, 30);
      const regras: Record<string, Regra[]> = {};
      await Promise.all(fields.map((f) => api.get<{ regras: Regra[] }>(`/custom-fields/${f.id}/where`).then((r) => { regras[f.id] = r.data.regras ?? []; }).catch(() => { regras[f.id] = []; })));
      // Ordem da árvore por nome: a chave é o caminho de nomes (o path guarda ids).
      const nomePorPath = new Map((fo.data ?? []).map((f) => [f.path, f.name]));
      const chave = (p: string) => p.split(".").map((_, i, seg) => nomePorPath.get(seg.slice(0, i + 1).join(".")) ?? "").join("\u0000");
      setDados({ folders: [...(fo.data ?? [])].sort((a, b) => chave(a.path).localeCompare(chave(b.path), "pt-BR")), fields, regras });
    }).catch(() => setFalhou(true));
  }, [companyId]);

  if (falhou) return <p role="alert" className="text-mac-body text-(--text-danger)">Não foi possível montar a matriz agora.</p>;
  if (!dados) return <div className="h-40 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" aria-label="Carregando" />;
  if (!dados.fields.length) return <p className="text-mac-body text-(--text-secondary)">Ainda não há campos no catálogo.</p>;

  // A regra que vale numa pasta é a da pasta mais próxima acima dela (ou a da empresa toda).
  function vale(fieldId: string, path: string): { r: Regra; proprio: boolean } | null {
    let melhor: Regra | null = null;
    for (const r of dados!.regras[fieldId] ?? []) {
      if (r.folder_path !== null && !(path === r.folder_path || path.startsWith(r.folder_path + "."))) continue;
      if (!melhor || (r.folder_path ?? "").length > (melhor.folder_path ?? "").length) melhor = r;
    }
    return melhor ? { r: melhor, proprio: melhor.folder_path === path } : null;
  }
  return (
    <div className="space-y-2">
      <p className="text-mac-caption text-(--text-secondary)">
        <span className="font-semibold text-(--text-primary)">●</span> definido na pasta · <span className="text-(--text-secondary)">↳</span> herdado de cima · <span className="text-(--text-danger)">*</span> obrigatório · <span>—</span> não vale. Clique na pasta para mudar.
      </p>
      <div className="overflow-auto max-h-[65vh] rounded-(--radius-control) border border-(--border-default)">
        <table className="border-separate border-spacing-0 text-mac-caption">
          <caption className="sr-only">Campos de metadado por pasta</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-20 bg-(--bg-card) px-3 py-2 text-left font-semibold text-(--text-secondary) border-b border-(--border-default) min-w-48">Pasta</th>
              {dados.fields.map((f) => (
                <th key={f.id} scope="col" className="sticky top-0 z-10 bg-(--bg-card) px-2 py-2 text-left font-semibold text-(--text-secondary) border-b border-(--border-default) min-w-24 max-w-36">
                  <span className="line-clamp-2">{f.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dados.folders.map((fo) => (
              <tr key={fo.id}>
                <th scope="row" className="sticky left-0 z-10 bg-(--bg-card) px-3 py-1.5 text-left font-medium text-(--text-primary) border-b border-(--border-default)"
                  style={{ paddingLeft: `${12 + Math.max(0, fo.path.split(".").length - 1) * 14}px` }}>
                  <button type="button" onClick={() => onOpenFolder(fo.id)} className="hover:underline text-left">{fo.name}</button>
                </th>
                {dados.fields.map((f) => {
                  const v = vale(f.id, fo.path);
                  const desc = !v ? "não vale" : v.r.mode === "exclude" ? "desligado aqui" : `${v.proprio ? "definido aqui" : "herdado"}${v.r.required ? ", obrigatório" : ""}`;
                  return (
                    <td key={f.id} className="px-2 py-1.5 border-b border-(--border-default) text-center" title={`${f.label} em ${fo.name}: ${desc}`}>
                      <span className="sr-only">{desc}</span>
                      <span aria-hidden="true" className={!v || v.r.mode === "exclude" ? "text-(--text-tertiary)" : v.proprio ? "font-semibold text-(--text-primary)" : "text-(--text-secondary)"}>
                        {!v || v.r.mode === "exclude" ? "—" : v.proprio ? "●" : "↳"}{v && v.r.mode !== "exclude" && v.r.required ? <span className="text-(--text-danger)">*</span> : null}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  const [tab, setTab] = useState<"catalog" | "tree" | "matrix">(searchParams.get("tab") === "tree" ? "tree" : searchParams.get("tab") === "matrix" ? "matrix" : "catalog");
  const [pastaMatriz, setPastaMatriz] = useState<string | undefined>(undefined);
  const [, setSearchParams] = useSearchParams();
  function changeTab(t: "catalog" | "tree" | "matrix") {
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
        <div role="tablist" aria-label="Metadados" className="mac-segmented mb-6">
          <button
            role="tab"
            aria-selected={tab === "catalog"}
            onClick={() => changeTab("catalog")}
            className="mac-segment"
          >
            <Tags className="w-4 h-4" /> Catálogo
          </button>
          <button
            role="tab"
            aria-selected={tab === "tree"}
            onClick={() => changeTab("tree")}
            className="mac-segment"
          >
            <FolderTree className="w-4 h-4" aria-hidden="true" /> Por pasta
          </button>
          <button role="tab" aria-selected={tab === "matrix"} onClick={() => changeTab("matrix")} className="mac-segment">
            Matriz
          </button>
        </div>

        {tab === "catalog" ? <CatalogTab companyId={current.id} companies={companies} />
          : tab === "matrix" ? <MatrixTab companyId={current.id} onOpenFolder={(id) => { setPastaMatriz(id); changeTab("tree"); }} />
          : <TreeTab key={pastaMatriz ?? "raiz"} companyId={current.id} initialFolderId={pastaMatriz ?? initialFolderId} onGoCatalog={() => changeTab("catalog")} />}
      </div>
    </div>
  );
}

/**
 * Aplicar um campo em várias pastas de uma vez (achado A8-13): antes era
 * uma pasta por vez, indo e voltando entre abas.
 */
function ApplyFieldDialog({ companyId, field, onClose }: { companyId: string; field: CustomField; onClose: () => void }) {
  const { success, error: showError } = useToast();
  const [folders, setFolders] = useState<FolderOption[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [required, setRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(0);
  useEffect(() => {
    api.get<FolderOption[]>("/folders", { params: { company_id: companyId, flat: true } }).then((r) => setFolders(r.data ?? [])).catch(() => setFolders([]));
  }, [companyId]);
  const sorted = [...(folders ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  async function apply() {
    setSaving(true);
    let ok = 0;
    const falhas: string[] = [];
    for (const id of sel) {
      try { await api.put("/folder-fields", { company_id: companyId, folder_id: id, custom_field_id: field.id, mode: "apply", required, display_order: 0 }); ok++; }
      catch { falhas.push(sorted.find((f) => f.id === id)?.name ?? id); }
      setDone((d) => d + 1);
    }
    setSaving(false);
    if (!falhas.length) { success(`“${field.label}” aplicado em ${ok} ${ok === 1 ? "pasta" : "pastas"} (e nas subpastas delas).`); onClose(); }
    else showError(`Aplicado em ${ok}. Falhou em: ${falhas.slice(0, 3).join(", ")}${falhas.length > 3 ? "…" : ""}`);
  }
  return (
    <Dialog onClose={onClose} title={`Aplicar “${field.label}” em pastas`} size="md" busy={saving}
      description="Marque as pastas: o campo vale nelas e nas subpastas. Onde já estava aplicado, a regra é atualizada."
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button><Button loading={saving} disabled={!sel.size} onClick={apply}>{saving ? `${done} de ${sel.size}…` : `Aplicar em ${sel.size}`}</Button></>}>
      {!folders ? <div className="h-32 rounded bg-(--bg-hover) animate-pulse" /> : sorted.length === 0 ? <p className="text-mac-body text-(--text-secondary)">Nenhuma pasta nesta empresa.</p> : (
        <div className="space-y-3">
          <ul className="max-h-72 overflow-y-auto rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)">
            {sorted.map((f) => (
              <li key={f.id}>
                <label className="flex items-center gap-2 px-3 min-h-10 pointer-coarse:min-h-11 cursor-pointer hover:bg-(--bg-hover)" style={{ paddingLeft: `${12 + (f.path.split(".").length - 1) * 16}px` }}>
                  <Checkbox checked={sel.has(f.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} />
                  <span className="text-mac-body text-(--text-primary) truncate">{f.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-mac-body text-(--text-primary)">
            <Checkbox checked={required} onChange={(e) => setRequired(e.target.checked)} /> Obrigatório nestas pastas
          </label>
        </div>
      )}
    </Dialog>
  );
}


/** Trocar o tipo do campo convertendo os valores (B1.3.10): prévia do que converte e do que se perde. */
function ChangeTypeDialog({ field, onClose, onDone }: { field: CustomField; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [tipo, setTipo] = useState<string>("");
  const [previa, setPrevia] = useState<{ total: number; convertidos: number; perdidos: number; exemplos_perdidos: { documento: string; valor: string; motivo: string }[]; opcoes?: string[] | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPrevia(null);
    if (!tipo) return;
    api.post(`/custom-fields/${field.id}/change-type`, { new_type: tipo, aplicar: false }).then((r) => setPrevia(r.data))
      .catch((e) => showError(friendlyError(e, "Não foi possível calcular a prévia.")));
  }, [tipo]); // eslint-disable-line react-hooks/exhaustive-deps
  async function aplicar() {
    setBusy(true);
    try {
      const r = await api.post(`/custom-fields/${field.id}/change-type`, { new_type: tipo, aplicar: true });
      success(`Agora é ${TYPE_LABEL[tipo as FieldType]}: ${r.data.convertidos} ${r.data.convertidos === 1 ? "valor convertido" : "valores convertidos"}${r.data.perdidos ? `, ${r.data.perdidos} apagados` : ""}.`);
      onDone();
    } catch (e) {
      showError(friendlyError(e, "Não foi possível trocar o tipo."));
    } finally {
      setBusy(false);
    }
  }
  const opcoes = (Object.keys(TYPE_LABEL) as FieldType[]).filter((t) => t !== field.type).map((t) => ({ value: t, label: TYPE_LABEL[t] }));
  return (
    <Dialog onClose={onClose} title={`Trocar o tipo de “${field.label}”`} size="md" busy={busy}
      description={`Hoje é ${TYPE_LABEL[field.type]}. Os valores já preenchidos são convertidos; o que não servir no tipo novo aparece antes de você confirmar.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={!previa} loading={busy} variant={previa?.perdidos ? "danger" : "primary"} onClick={aplicar}>{previa?.perdidos ? `Trocar e apagar ${previa.perdidos}` : "Trocar o tipo"}</Button></>}>
      <div className="space-y-3">
        <Dropdown ariaLabel="Tipo novo" value={tipo} onChange={setTipo} options={[{ value: "", label: "Escolha o tipo novo" }, ...opcoes]} />
        {tipo && !previa && <div className="h-12 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />}
        {previa && (
          <div aria-live="polite" className="space-y-2 text-mac-body text-(--text-primary)">
            <p>{previa.total === 0 ? "Nenhum documento tem valor neste campo: a troca não perde nada." : `${previa.convertidos} de ${previa.total} ${previa.total === 1 ? "valor converte" : "valores convertem"}.`}</p>
            {previa.opcoes && <p className="text-mac-caption text-(--text-secondary)">As opções da seleção passam a ser: {previa.opcoes.join(", ") || "nenhuma"}.</p>}
            {previa.perdidos > 0 && (
              <div className="rounded-(--radius-control) border border-(--border-default) bg-(--bg-hover) px-3 py-2">
                <p className="font-medium text-(--text-danger)">{previa.perdidos} {previa.perdidos === 1 ? "valor não converte e será apagado" : "valores não convertem e serão apagados"}:</p>
                <ul className="mt-1 space-y-0.5 text-mac-caption text-(--text-secondary)">
                  {previa.exemplos_perdidos.map((x, i) => <li key={i}>{x.documento}: “{x.valor}” ({x.motivo})</li>)}
                  {previa.perdidos > previa.exemplos_perdidos.length && <li>e mais {previa.perdidos - previa.exemplos_perdidos.length}.</li>}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Aplicar o valor padrão aos documentos que já existem (FA-A8-09), com prévia. */
function ApplyDefaultDialog({ rule, label, onClose }: { rule: FolderFieldRule; label: string; onClose: () => void }) {
  const { success, error: showError } = useToast();
  const [modo, setModo] = useState<"vazios" | "sobrescrever">("vazios");
  const [previa, setPrevia] = useState<{ documentos: number; vazios: number; diferentes: number; vao_mudar: number; valor: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPrevia(null);
    api.post(`/folder-fields/${rule.id}/apply-default`, { modo, aplicar: false }).then((r) => setPrevia(r.data))
      .catch((e) => showError(friendlyError(e, "Não foi possível calcular a prévia.")));
  }, [modo, rule.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function aplicar() {
    setBusy(true);
    try {
      const r = await api.post(`/folder-fields/${rule.id}/apply-default`, { modo, aplicar: true });
      success(`${r.data.vao_mudar} ${r.data.vao_mudar === 1 ? "documento atualizado" : "documentos atualizados"} com “${r.data.valor}”.`);
      onClose();
    } catch (e) {
      showError(friendlyError(e, "Não foi possível aplicar."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog onClose={onClose} title={`Aplicar o padrão de “${label}” aos documentos`} size="sm" busy={busy}
      description={`Os documentos que já estão nesta pasta (e nas subpastas sem regra própria) recebem “${rule.default_value}”.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!previa || previa.vao_mudar === 0} onClick={aplicar}>{previa ? `Aplicar em ${previa.vao_mudar}` : "Aplicar"}</Button></>}>
      <fieldset className="space-y-2">
        <legend className="sr-only">O que atualizar</legend>
        {([["vazios", "Só os documentos sem valor neste campo"], ["sobrescrever", "Também trocar os valores diferentes"]] as const).map(([v, l]) => (
          <label key={v} className="flex items-center gap-2 text-mac-body text-(--text-primary)">
            <input type="radio" name="modo-padrao" checked={modo === v} onChange={() => setModo(v)} /> {l}
          </label>
        ))}
      </fieldset>
      <p aria-live="polite" className="mt-3 text-mac-caption text-(--text-secondary)">
        {previa ? `${previa.documentos} ${previa.documentos === 1 ? "documento" : "documentos"} na regra: ${previa.vazios} sem valor, ${previa.diferentes} com valor diferente. Vão mudar ${previa.vao_mudar}.` : "Calculando…"}
      </p>
    </Dialog>
  );
}
