import { useEffect, useRef, useState, useCallback, useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { relativeDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import {
  Anchor,
  ChevronRight,
  ChevronDown,
  X,
  MoreHorizontal,
  Download,
  Eye,
  Share2,
  Clock,
  GitBranch,
  Archive,
  Lock,
  Check, Copy } from "lucide-react";
import api from "@/lib/api";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import { pushUndo, useUndo } from "@/lib/undo";
import Dropdown from "@/components/ui/Dropdown";
import VersionsPanel from "@/components/documents/VersionsPanel";
import ActivityFeed from "@/components/shared/ActivityFeed";
import { StatusChip, type Instance } from "@/components/obligations/shared";
import ShareModal from "@/components/documents/ShareModal";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import {
  maskValue,
  validateValue,
  PLACEHOLDER,
  INPUT_MODE,
  fieldOptions,
  isChoice,
  type FieldType,
} from "@/components/documents/fieldMasks";
import { friendlyError } from "@/lib/errors";
import IntegrityCheck from "@/components/documents/IntegrityCheck";
import LinkAccesses from "@/components/documents/LinkAccesses";
import { useFeatures } from "@/lib/CompanyContext";
import {
  type Document,
  type ResolvedField,
  type DocFieldValueRow,
  fmtSize,
  fmtDateFull,
  kindLabel,
  ocrBadge,
} from "@/components/documents/docShared";

// Metadados personalizados (ADENDO-08 M-G): formulário por tipo, com máscara,
// validação no próprio campo e salvamento automático anunciado (A5-11, A5-15).
export type FieldSaveStatus = "idle" | "saving" | "saved" | "error";

export function FieldStatusIndicator({ status, message }: { status: FieldSaveStatus; message?: string }) {
  if (status === "idle") return null;
  if (status === "saving") return <span className="text-mac-caption text-(--text-secondary)">salvando…</span>;
  if (status === "error") return <span className="text-mac-caption text-(--text-danger)">{message ?? "não salvou"}</span>;
  return <span className="reveal text-mac-caption text-(--text-success)">salvo</span>;
}

/** Acordeão acessível com altura animada (A5-05, A5-07, A5-22). */
export function Disclosure({ icon, title, summary, children, defaultOpen = false, onOpen }: {
  icon: ReactNode; title: string; summary?: string; children: ReactNode; defaultOpen?: boolean; onOpen?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="border-t border-(--border-default) pt-2">
      <h3>
        <button
          aria-expanded={open}
          aria-controls={`${id}-painel`}
          onClick={() => { const next = !open; setOpen(next); if (next) onOpen?.(); }}
          className="w-full flex items-center justify-between gap-2 min-h-9 pointer-coarse:min-h-11 rounded-(--radius-control) text-mac-body text-(--text-primary) hover:text-(--text-accent)"
        >
          <span className="flex items-center gap-2">{icon}{title}{summary && <span className="text-mac-caption text-(--text-secondary) font-normal">{summary}</span>}</span>
          <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </h3>
      <div id={`${id}-painel`} className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`} inert={!open}>
        <div className="overflow-hidden"><div className="pt-2 pb-1">{children}</div></div>
      </div>
    </div>
  );
}

export function MetadataSection({ doc, companyId, canEdit, onSaved }: { doc: Document; companyId: string; canEdit: boolean; onSaved: (fieldId: string, value: string) => void }) {
  const [fields, setFields] = useState<ResolvedField[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedFieldIds, setSavedFieldIds] = useState<Set<string>>(new Set());
  const [fieldStatus, setFieldStatus] = useState<Record<string, FieldSaveStatus>>({});
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const debounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const savedValues = useRef<Record<string, string>>({});
  const [undoFor, setUndoFor] = useState<Record<string, string>>({});
  const [metaBusca, setMetaBusca] = useState("");
  const [recolhidos, setRecolhidos] = useState<Set<string>>(new Set(["opc"]));
  const { run: runUndo } = useUndo();
  const uid = useId();

  const load = useCallback(() => {
    if (!doc.folder_id) { setFields([]); return; }
    setFields(null);
    setFailed(false);
    Promise.all([
      api.get<ResolvedField[]>("/folder-fields/resolved", { params: { company_id: companyId, folder_id: doc.folder_id } }),
      api.get<DocFieldValueRow[]>(`/documents/${doc.id}/field-values`),
    ]).then(([fRes, vRes]) => {
      const fetched = Array.isArray(fRes.data) ? [...fRes.data].sort((a, b) => a.display_order - b.display_order) : [];
      const vmap: Record<string, string> = {};
      const saved = new Set<string>();
      for (const row of Array.isArray(vRes.data) ? vRes.data : []) { vmap[row.custom_field_id] = row.value_text; saved.add(row.custom_field_id); }
      savedValues.current = { ...vmap };
      setUndoFor({});
      for (const f of fetched) if (!saved.has(f.custom_field_id) && f.default_value) vmap[f.custom_field_id] = f.default_value;
      setFields(fetched); setValues(vmap); setSavedFieldIds(saved); setFieldStatus({}); setFieldError({});
    }).catch(() => { setFailed(true); setFields([]); });
  }, [doc.id, doc.folder_id, companyId]);
  useEffect(load, [load]);
  useEffect(() => () => { Object.values(debounceRefs.current).forEach(clearTimeout); }, []);

  async function saveField(f: ResolvedField, rawValue: string) {
    const trimmed = rawValue.trim();
    const invalid = validateValue(f.type as FieldType, trimmed);
    if (invalid) { setFieldError((s) => ({ ...s, [f.custom_field_id]: invalid })); setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "idle" })); return; }
    setFieldError((s) => { const n = { ...s }; delete n[f.custom_field_id]; return n; });
    if (!trimmed) { setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "idle" })); return; }
    setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "saving" }));
    const before = savedFieldIds.has(f.custom_field_id) ? savedValues.current[f.custom_field_id] : undefined;
    try {
      await api.put(`/documents/${doc.id}/field-values`, [{ custom_field_id: f.custom_field_id, value: trimmed }], { params: { company_id: companyId } });
      // Desfazer (Ctrl+Z ou "Desfazer" ao lado do campo) volta ao valor que
      // estava salvo antes; vários salvamentos seguidos no mesmo campo viram
      // uma entrada só. Campo que estava vazio não tem para onde voltar.
      if (before !== undefined && before !== trimmed) {
        const entry = pushUndo(`editar "${f.label}"`, async () => {
          await api.put(`/documents/${doc.id}/field-values`, [{ custom_field_id: f.custom_field_id, value: before }], { params: { company_id: companyId } });
          savedValues.current[f.custom_field_id] = before;
          setValues((s) => ({ ...s, [f.custom_field_id]: before }));
          onSaved(f.custom_field_id, before);
          setUndoFor((u) => { const n = { ...u }; delete n[f.custom_field_id]; return n; });
        }, `meta:${doc.id}:${f.custom_field_id}`);
        setUndoFor((u) => ({ ...u, [f.custom_field_id]: entry.id }));
      }
      savedValues.current[f.custom_field_id] = trimmed;
      setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "saved" }));
      setSavedFieldIds((s) => new Set(s).add(f.custom_field_id));
      onSaved(f.custom_field_id, trimmed);
      window.setTimeout(() => setFieldStatus((s) => (s[f.custom_field_id] === "saved" ? { ...s, [f.custom_field_id]: "idle" } : s)), 2500);
    } catch (e: any) {
      setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "error" }));
      setFieldError((s) => ({ ...s, [f.custom_field_id]: e?.response?.data?.detail ?? "Não salvou. Confira o valor e tente de novo." }));
    }
  }

  if (fields === null) {
    return <div className="border-t border-(--border-default) pt-3 space-y-2" aria-label="Carregando metadados">{[0, 1].map((i) => <div key={i} className="h-9 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>;
  }
  if (failed) {
    return <p role="alert" className="border-t border-(--border-default) pt-3 text-mac-body text-(--text-secondary)">Não carregou os metadados. <button onClick={load} className="font-medium text-(--text-accent) underline underline-offset-2">Tentar de novo</button></p>;
  }
  const visibleAll = fields.filter((f) => !f.condition_field_id || (values[f.condition_field_id] ?? "") === (f.condition_value ?? ""));
  if (visibleAll.length === 0) return null;
  // Muitos campos (A5-13, B1.3.8): busca pelo nome e grupos recolhíveis
  // (obrigatórios abertos; opcionais recolhem quando passam de 6).
  const muitos = visibleAll.length > 6;
  const dobra = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const visible = metaBusca.trim() ? visibleAll.filter((f) => dobra(f.label).includes(dobra(metaBusca.trim()))) : visibleAll;
  const obrig = visible.filter((f) => f.required);
  const opc = visible.filter((f) => !f.required);
  const grupos: { id: string; titulo: string; itens: ResolvedField[] }[] = muitos && obrig.length && opc.length
    ? [{ id: "obrig", titulo: "Obrigatórios", itens: obrig }, { id: "opc", titulo: "Opcionais", itens: opc }]
    : [{ id: "todos", titulo: "", itens: visible }];

  return (
    <section aria-labelledby={`${uid}-meta`} className="border-t border-(--border-default) pt-3 space-y-3">
      <h3 id={`${uid}-meta`} className="text-mac-body font-semibold text-(--text-primary)">Metadados{muitos && <span className="font-normal text-(--text-secondary)"> · {visibleAll.length}</span>}</h3>
      {muitos && (
        <input type="search" value={metaBusca} onChange={(e) => setMetaBusca(e.target.value)} placeholder="Buscar campo" aria-label="Buscar campo de metadado"
          className="mac-field w-full h-8 pointer-coarse:h-11 px-3 text-mac-body text-(--text-primary)" />
      )}
      {muitos && visible.length === 0 && <p className="text-mac-caption text-(--text-secondary)">Nenhum campo com “{metaBusca}”.</p>}
      {grupos.map((g) => {
        const fechado = !metaBusca.trim() && g.titulo !== "" && recolhidos.has(g.id);
        return (
          <div key={g.id} className="space-y-3">
            {g.titulo && (
              <button type="button" aria-expanded={!fechado}
                onClick={() => setRecolhidos((r) => { const n = new Set(r); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })}
                className="flex items-center gap-1 text-mac-caption font-semibold text-(--text-secondary) hover:text-(--text-primary)">
                <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-fast ${fechado ? "" : "rotate-90"}`} aria-hidden />
                {g.titulo} · {g.itens.length}{fechado && g.id === "opc" ? ` (${g.itens.filter((f) => (values[f.custom_field_id] ?? "") !== "").length} preenchidos)` : ""}
              </button>
            )}
            {!fechado && g.itens.map((f) => {
        const fid = `${uid}-${f.custom_field_id}`;
        const err = fieldError[f.custom_field_id];
        const status = fieldStatus[f.custom_field_id] ?? "idle";
        const brokeInheritance = f.default_value != null && savedFieldIds.has(f.custom_field_id) && values[f.custom_field_id] !== f.default_value;
        const fromDefault = f.default_value != null && !savedFieldIds.has(f.custom_field_id) && values[f.custom_field_id] === f.default_value;
        return (
          <div key={f.custom_field_id}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label htmlFor={fid} className="text-mac-caption font-medium text-(--text-secondary) flex items-center gap-1">
                {f.label}{f.required && <span className="text-(--text-danger)" aria-label="obrigatório">*</span>}
                {brokeInheritance && <span className="text-(--text-warning) inline-flex" title={`Diferente do padrão da pasta ("${f.default_value}")`}><GitBranch className="w-3 h-3" aria-hidden /><span className="sr-only">diferente do padrão da pasta</span></span>}
                {fromDefault && <span className="text-(--text-secondary) font-normal">· padrão da pasta</span>}
              </label>
              <span className="flex items-center gap-2">
                {undoFor[f.custom_field_id] && status !== "saving" && (
                  <button type="button" onClick={() => runUndo(undoFor[f.custom_field_id])} className="text-mac-caption font-medium text-(--text-accent) hover:underline underline-offset-2">Desfazer</button>
                )}
                <span aria-live="polite"><FieldStatusIndicator status={status} message={status === "error" ? "não salvou" : undefined} /></span>
              </span>
            </div>
            {isChoice(f.type) ? (
              <Dropdown
                id={fid}
                value={values[f.custom_field_id] ?? ""}
                onChange={(v) => { setValues((s) => ({ ...s, [f.custom_field_id]: v })); saveField(f, v); }}
                placeholder="Escolha"
                disabled={!canEdit}
                ariaLabel={f.label}
                options={fieldOptions(f.type, f.format_config?.options).map((o) => ({ value: o, label: o }))}
              />
            ) : f.type === "multipla" ? (
              // Múltipla escolha (B1.3.2): botões que ligam e desligam cada opção.
              <div id={fid} role="group" aria-label={f.label} className="flex flex-wrap gap-1.5">
                {fieldOptions("selecao", f.format_config?.options).map((o) => {
                  const atuais = (values[f.custom_field_id] ?? "").split(";").map((x) => x.trim()).filter(Boolean);
                  const on = atuais.includes(o);
                  return (
                    <button key={o} type="button" aria-pressed={on} disabled={!canEdit}
                      onClick={() => {
                        const prox = on ? atuais.filter((x) => x !== o) : [...atuais, o];
                        const v = prox.join("; ");
                        setValues((st) => ({ ...st, [f.custom_field_id]: v }));
                        saveField(f, v);
                      }}
                      className={`px-2.5 h-7 pointer-coarse:h-10 rounded-full text-mac-caption font-medium border transition-colors duration-fast disabled:opacity-(--opacity-disabled) ${on ? "bg-(--accent) text-white border-(--accent)" : "border-(--border-control) text-(--text-primary) hover:bg-(--bg-hover)"}`}>
                      {o}
                    </button>
                  );
                })}
              </div>
            ) : f.type === "texto_longo" ? (
              <textarea
                id={fid}
                rows={3}
                maxLength={2000}
                value={values[f.custom_field_id] ?? ""}
                readOnly={!canEdit}
                aria-invalid={err ? true : undefined}
                aria-describedby={err ? `${fid}-erro` : undefined}
                onChange={(e) => {
                  const v = e.target.value;
                  setValues((st) => ({ ...st, [f.custom_field_id]: v }));
                  setFieldStatus((st) => ({ ...st, [f.custom_field_id]: "idle" }));
                }}
                onBlur={(e) => saveField(f, e.target.value)}
                className={`w-full px-3 py-2 text-mac-body pointer-coarse:text-[16px] bg-(--bg-card) border rounded-(--radius-control) text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) read-only:bg-(--bg-hover) ${err ? "border-red-500" : "border-(--border-control)"}`}
              />
            ) : (
              <input
                id={fid}
                type="text"
                inputMode={INPUT_MODE[f.type as FieldType]}
                value={values[f.custom_field_id] ?? ""}
                readOnly={!canEdit}
                aria-invalid={err ? true : undefined}
                aria-describedby={err ? `${fid}-erro` : undefined}
                aria-required={f.required || undefined}
                onChange={(e) => {
                  const v = maskValue(f.type as FieldType, e.target.value);
                  setValues((s) => ({ ...s, [f.custom_field_id]: v }));
                  setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "idle" }));
                  if (debounceRefs.current[f.custom_field_id]) clearTimeout(debounceRefs.current[f.custom_field_id]);
                  debounceRefs.current[f.custom_field_id] = setTimeout(() => saveField(f, v), 900);
                }}
                onBlur={(e) => {
                  if (debounceRefs.current[f.custom_field_id]) clearTimeout(debounceRefs.current[f.custom_field_id]);
                  saveField(f, e.target.value);
                }}
                placeholder={PLACEHOLDER[f.type as FieldType]}
                className={`w-full h-9 pointer-coarse:h-11 px-3 text-mac-body pointer-coarse:text-[16px] bg-(--bg-card) border rounded-(--radius-control) text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) read-only:bg-(--bg-hover) ${err ? "border-red-500" : "border-(--border-control)"}`}
              />
            )}
            {err && <p id={`${fid}-erro`} className="mt-1 text-mac-caption text-(--text-danger)">{err}</p>}
          </div>
        );
      })}
          </div>
        );
      })}
    </section>
  );
}

/** Filtro por tipo de evento na atividade do documento (A5-28). */
const DOC_EVENT_FILTERS: { id: string; label: string; actions?: string }[] = [
  { id: "", label: "Tudo" },
  { id: "mudancas", label: "Mudanças", actions: "upload,rename,move,update_metadata,version_delete,copy,restore,delete" },
  { id: "acessos", label: "Aberturas", actions: "view,download" },
];
function DocActivity({ companyId, docId }: { companyId: string; docId: string }) {
  const [f, setF] = useState("");
  const filtro = DOC_EVENT_FILTERS.find((x) => x.id === f);
  return (
    <div className="space-y-2">
      <div role="tablist" aria-label="Tipo de evento" className="mac-segmented">
        {DOC_EVENT_FILTERS.map((x) => (
          <button key={x.id} role="tab" aria-selected={f === x.id} onClick={() => setF(x.id)} className="mac-segment">{x.label}</button>
        ))}
      </div>
      <ActivityFeed companyId={companyId} itemId={docId} pageSize={20} groupByDay={false}
        filters={filtro?.actions ? { action: filtro.actions } : undefined}
        emptyDescription={f ? "Nenhum evento deste tipo neste documento." : "Nenhuma atividade registrada neste documento ainda."} />
    </div>
  );
}

export interface RetentionCandidate {
  policy_id: string; policy_name: string; locked: boolean; is_indeterminate: boolean;
  expires_at: string | null; company_wide: boolean; eligible: boolean; is_winner: boolean;
}

export const brDate = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("pt-BR") : "—");

export function DocumentRetentionSection({ docId }: { docId: string }) {
  const [info, setInfo] = useState<{ policy_name: string | null; expires_at: string | null; is_indeterminate: boolean | null; locked: boolean; under_hold: boolean } | null | "erro">(null);
  const [candidates, setCandidates] = useState<RetentionCandidate[] | null>(null);
  const [showCalc, setShowCalc] = useState(false);
  const load = () => { setInfo(null); api.get(`/documents/${docId}/retention`).then((r) => setInfo(r.data)).catch(() => setInfo("erro")); };
  // Carrega junto com o painel: o cabeçalho já diz o prazo, sem abrir (A5-24).
  useEffect(load, [docId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (showCalc) api.get<{ candidates: RetentionCandidate[] }>(`/documents/${docId}/retention/explain`).then((r) => setCandidates(r.data.candidates)).catch(() => setCandidates([])); }, [showCalc, docId]);
  const resumo = info === null || info === "erro" ? undefined
    : info.under_hold ? "bloqueio judicial"
    : !info.policy_name ? "sem prazo"
    : info.is_indeterminate ? "guarda permanente"
    : `até ${brDate(info.expires_at)}`;
  return (
    <Disclosure icon={<Archive className="w-4 h-4" aria-hidden />} title="Retenção" summary={resumo}>
      {info === null ? (
        <div className="h-10 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" />
      ) : info === "erro" ? (
        <p role="alert" className="text-mac-caption text-(--text-secondary)">Não foi possível conferir a retenção agora. Não descarte o documento sem conferir. <button onClick={load} className="font-medium text-(--text-accent) underline underline-offset-2">Tentar de novo</button></p>
      ) : (
        <div className="text-mac-caption text-(--text-secondary) space-y-1.5">
          {info.under_hold && <p className="flex items-center gap-1.5 text-(--text-warning) font-medium"><Lock className="w-3.5 h-3.5" aria-hidden /> Sob retenção legal (legal hold): não pode ser excluído.</p>}
          {!info.policy_name ? (
            <p>Nenhuma política de retenção se aplica a este documento.</p>
          ) : (
            <>
              <p>Política: <span className="font-medium text-(--text-primary)">{info.policy_name}</span>{info.locked && <span className="ml-1">(obrigatória)</span>}</p>
              <p>{info.is_indeterminate ? "Guarda por prazo indeterminado." : `Pode ser descartado a partir de ${brDate(info.expires_at)}.`}</p>
              <button onClick={() => setShowCalc((v) => !v)} aria-expanded={showCalc} className="font-medium text-(--text-accent) underline-offset-2 hover:underline min-h-6 pointer-coarse:min-h-11">
                {showCalc ? "Ocultar como foi calculado" : "Ver como foi calculado"}
              </button>
              {showCalc && (
                <ul className="space-y-1 pt-1">
                  {candidates === null ? <li className="h-8 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" /> : candidates.length === 0 ? (
                    <li>Nenhuma política atribuída à empresa ou às pastas deste documento.</li>
                  ) : candidates.map((c) => (
                    <li key={c.policy_id} className="flex items-start gap-1.5">
                      {c.is_winner ? <Check className="w-3.5 h-3.5 text-(--text-success) shrink-0 mt-0.5" aria-hidden /> : <span className="w-3.5 shrink-0" />}
                      <span className={c.is_winner ? "text-(--text-primary)" : ""}>
                        {c.policy_name}{c.locked ? " (obrigatória)" : ""} — {c.is_indeterminate ? "indeterminado" : brDate(c.expires_at)} · {c.company_wide ? "empresa toda" : "pasta"}
                        {c.is_winner ? <strong className="ml-1 text-(--text-success)">vale esta</strong> : !c.eligible ? " · perde para a obrigatória" : " · prazo menor"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Disclosure>
  );
}

/** Obrigações que este documento comprova (achado A7-54): some quando não há nenhuma. */
export function DocumentObligations({ docId }: { docId: string }) {
  const [items, setItems] = useState<Instance[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<Instance[]>(`/documents/${docId}/obligations`).then((r) => { if (alive) setItems(r.data ?? []); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [docId]);
  if (!items?.length) return null;
  return (
    <section aria-label="Obrigações que este documento comprova" className="space-y-1.5">
      <h3 className="text-mac-body font-semibold text-(--text-primary)">Comprova</h3>
      <ul className="space-y-1">
        {items.map((o) => (
          <li key={o.id} className="flex items-center gap-2 min-h-8">
            <Link to={`/obligations?instancia=${o.id}`} className="flex-1 min-w-0 truncate text-mac-caption text-(--text-accent) hover:underline">
              {o.template_name} · {o.period_label}
            </Link>
            <StatusChip status={o.effective_status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface NotaFiscal {
  chave: string | null; modelo: string | null; numero: string | null; serie: string | null; data_emissao: string | null;
  emitente_cnpj: string | null; emitente_nome: string | null; destinatario_doc: string | null; destinatario_nome: string | null;
  valor_total: number | null; duplicatas: { id: string; name: string; folder_id: string; folder_name: string }[];
  cancelada?: boolean;
  eventos?: { tipo: string; descricao: string; texto: string | null; protocolo: string | null; data_evento: string | null; document_id: string; folder_id: string; name: string }[];
}
interface EventoNfe {
  chave: string; tipo: string; descricao: string; texto: string | null; protocolo: string | null; data_evento: string | null;
  nota: { id: string; name: string; folder_id: string; numero: string | null; serie: string | null } | null;
}

function fmtDoc(v: string | null) {
  if (!v) return "";
  if (v.length === 14) return v.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (v.length === 11) return v.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return v;
}

/** NF-e lida no envio (FA-A4-12, B2.5.6): dados da nota e aviso quando a mesma chave já está no acervo. */
export function DocumentNfe({ docId, name }: { docId: string; name: string }) {
  const [nota, setNota] = useState<NotaFiscal | null>(null);
  const [evento, setEvento] = useState<EventoNfe | null>(null);
  const [copiada, setCopiada] = useState(false);
  const ehXml = /\.xml$/i.test(name);
  useEffect(() => {
    if (!ehXml) return;
    let vivo = true;
    setNota(null);
    setEvento(null);
    api.get(`/documents/${docId}`).then((r) => { if (vivo) { setNota(r.data?.nfe ?? null); setEvento(r.data?.nfe_evento ?? null); } }).catch(() => {});
    return () => { vivo = false; };
  }, [docId, ehXml]);
  if (ehXml && !nota && evento) {
    // Evento de NF-e (B2.5.9): o que é e a nota a que se refere.
    return (
      <section aria-label="Evento de nota fiscal" className="space-y-1.5 border-t border-(--border-default) pt-3">
        <h3 className="text-mac-body font-semibold text-(--text-primary)">{evento.descricao}</h3>
        <p className="text-mac-caption text-(--text-secondary)">
          {evento.data_evento ? `${fmtDateFull(evento.data_evento)} · ` : ""}{evento.protocolo ? `protocolo ${evento.protocolo}` : "sem protocolo no arquivo"}
        </p>
        {evento.texto && <p className="text-mac-caption text-(--text-primary) whitespace-pre-line">{evento.texto}</p>}
        {evento.nota
          ? <p className="text-mac-caption">Da nota <Link to={`/documents?folder_id=${evento.nota.folder_id}&doc=${evento.nota.id}`} className="text-(--text-accent) hover:underline">NF-e {evento.nota.numero}{evento.nota.serie ? `/${evento.nota.serie}` : ""}</Link></p>
          : <p className="text-mac-caption text-(--text-secondary)">A nota deste evento ainda não está no acervo.</p>}
      </section>
    );
  }
  if (!ehXml || !nota) return null;
  const chaveFmt = nota.chave ? nota.chave.replace(/(\d{4})(?=\d)/g, "$1 ") : null;
  return (
    <section aria-label="Nota fiscal" className="space-y-2 border-t border-(--border-default) pt-3">
      <h3 className="flex flex-wrap items-center gap-2 text-mac-body font-semibold text-(--text-primary)">
        {nota.modelo === "65" ? "NFC-e" : "NF-e"} {nota.numero}{nota.serie ? ` · série ${nota.serie}` : ""}
        {nota.cancelada && <span className="rounded-full bg-(--tint-danger) px-2 py-0.5 text-mac-caption font-medium text-(--text-danger)">Cancelada</span>}
      </h3>
      {!!nota.eventos?.length && (
        <ul className="space-y-0.5 text-mac-caption text-(--text-secondary)" aria-label="Eventos da nota">
          {nota.eventos.map((e) => (
            <li key={e.document_id + e.tipo}>
              <Link to={`/documents?folder_id=${e.folder_id}&doc=${e.document_id}`} className="text-(--text-accent) hover:underline">{e.descricao}</Link>
              {e.data_evento ? ` em ${new Date(e.data_evento).toLocaleDateString("pt-BR")}` : ""}{e.texto ? `: ${e.texto.slice(0, 120)}` : ""}
            </li>
          ))}
        </ul>
      )}
      {nota.duplicatas.length > 0 && (
        <div role="status" className="rounded-(--radius-control) border border-(--border-default) bg-(--bg-hover) px-3 py-2 text-mac-caption text-(--text-primary)">
          <p className="font-medium text-(--text-warning)">Esta nota já está no acervo {nota.duplicatas.length === 1 ? "em outro arquivo" : `em ${nota.duplicatas.length} outros arquivos`}:</p>
          <ul className="mt-1 space-y-0.5">
            {nota.duplicatas.map((d) => (
              <li key={d.id}><Link to={`/documents?folder_id=${d.folder_id}&doc=${d.id}`} className="text-(--text-accent) hover:underline">{d.name}</Link> <span className="text-(--text-secondary)">em {d.folder_name}</span></li>
            ))}
          </ul>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-mac-caption">
        {nota.emitente_nome && <><dt className="text-(--text-secondary)">Emitente</dt><dd className="text-(--text-primary) text-right break-words">{nota.emitente_nome}<br /><span className="tabular-nums text-(--text-secondary)">{fmtDoc(nota.emitente_cnpj)}</span></dd></>}
        {nota.destinatario_nome && <><dt className="text-(--text-secondary)">Destinatário</dt><dd className="text-(--text-primary) text-right break-words">{nota.destinatario_nome}<br /><span className="tabular-nums text-(--text-secondary)">{fmtDoc(nota.destinatario_doc)}</span></dd></>}
        {nota.valor_total != null && <><dt className="text-(--text-secondary)">Valor</dt><dd className="text-(--text-primary) text-right tabular-nums">{nota.valor_total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</dd></>}
        {nota.data_emissao && <><dt className="text-(--text-secondary)">Emissão</dt><dd className="text-(--text-primary) text-right">{fmtDateFull(nota.data_emissao)}</dd></>}
      </dl>
      {chaveFmt && (
        <div className="flex items-start gap-2">
          <p className="flex-1 font-mono text-[11px] leading-4 text-(--text-secondary) break-all" aria-label="Chave de acesso">{chaveFmt}</p>
          <button type="button" aria-label="Copiar a chave de acesso"
            onClick={() => { navigator.clipboard?.writeText(nota.chave!).then(() => { setCopiada(true); window.setTimeout(() => setCopiada(false), 1500); }).catch(() => {}); }}
            className="shrink-0 p-1.5 pointer-coarse:p-3 rounded-(--radius-control) text-(--text-secondary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
            <Copy className="w-3.5 h-3.5" aria-hidden />
          </button>
          <span aria-live="polite" className="sr-only">{copiada ? "Chave copiada" : ""}</span>
        </div>
      )}
    </section>
  );
}

/** Reserva para edição (B1.4.7): quem reserva é o único que altera até liberar. */
export function DocumentCheckout({ docId, canEdit, onChanged }: { docId: string; canEdit: boolean; onChanged: () => void }) {
  const { user } = useAuthContext();
  const { success, error: showError } = useToast();
  const [reserva, setReserva] = useState<{ user_id: string; full_name: string; created_at: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  function load() { api.get(`/documents/${docId}`).then((r) => setReserva(r.data?.checkout ?? null)).catch(() => setReserva(null)); }
  useEffect(load, [docId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function agir(acao: "checkout" | "checkin") {
    setBusy(true);
    try {
      await api.post(`/documents/${docId}/${acao}`, acao === "checkout" ? {} : undefined);
      success(acao === "checkout" ? "Reservado para você: os outros só leem até você liberar." : "Reserva liberada.");
      load();
      onChanged();
    } catch (e) {
      showError(friendlyError(e, "Não foi possível agora."));
    } finally {
      setBusy(false);
    }
  }
  if (reserva === undefined || (!canEdit && !reserva)) return null;
  const minha = reserva?.user_id === user?.id;
  return reserva ? (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-(--radius-control) border border-(--border-default) bg-(--bg-hover) px-3 py-2 text-mac-caption text-(--text-primary)">
      <Lock className="w-3.5 h-3.5 text-(--text-warning)" aria-hidden />
      <span className="flex-1 min-w-0">{minha ? "Reservado para você" : `Reservado por ${reserva.full_name}`} desde {new Date(reserva.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}{minha ? "" : ": dá para abrir e baixar."}</span>
      {canEdit && <Button size="sm" variant="secondary" loading={busy} onClick={() => agir("checkin")}>{minha ? "Liberar" : "Liberar (admin)"}</Button>}
    </div>
  ) : (
    <button onClick={() => agir("checkout")} disabled={busy}
      className="w-full flex items-center justify-center gap-2 h-9 pointer-coarse:h-11 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover) disabled:opacity-(--opacity-disabled)">
      <Lock className="w-4 h-4" aria-hidden />Reservar para edição
    </button>
  );
}

export function DetailDrawer({ doc, companyId, variant = "modal", path, canEdit, onClose, onFavorite, onPreview, onMenu, onChanged, onFieldSaved }: {
  doc: Document; companyId: string; variant?: "modal" | "panel"; path: string; canEdit: boolean;
  onClose: () => void; onFavorite: () => void; onPreview: () => void; onMenu: (el: HTMLElement) => void; onChanged: () => void;
  onFieldSaved: (docId: string, fieldId: string, value: string) => void;
}) {
  const { success, error: showError } = useToast();
  const { offer: offerUndo } = useUndo();
  const recursos = useFeatures();
  // Resumo da atividade no cabeçalho (A5-26): quantos eventos e o último.
  const [act, setAct] = useState<{ total: number; last: string | null } | null>(null);
  useEffect(() => {
    let vivo = true;
    setAct(null);
    api.get(`/activity`, { params: { company_id: companyId, item_id: doc.id, page_size: 1 } })
      .then((r) => { if (vivo) setAct({ total: r.data?.total ?? 0, last: r.data?.results?.[0]?.created_at ?? null }); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [doc.id, companyId]);
  const [favorited, setFavorited] = useState(doc.favorited ?? false);
  const [sharing, setSharing] = useState(false);
  const [shareCount, setShareCount] = useState(doc.active_share_count ?? 0);
  // A âncora "cai" ao ancorar (A5-89): a animação anchor-drop que estava sem uso.
  const [dropping, setDropping] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { setFavorited(doc.favorited ?? false); setShareCount(doc.active_share_count ?? 0); }, [doc.id, doc.favorited, doc.active_share_count]);

  async function toggleFavorite() {
    const goingTo = !favorited;
    setFavorited(goingTo);
    try {
      const unanchor = async () => {
        const list = await api.get<{ id: string; document_id: string | null }[]>("/favorites");
        const id = list.data.find((f) => f.document_id === doc.id)?.id;
        if (id) await api.delete(`/favorites/${id}`);
      };
      const anchor = async () => { await api.post("/favorites", { document_id: doc.id }); };
      if (goingTo) {
        await anchor();
        offerUndo(`"${doc.name}" ancorado.`, `ancorar "${doc.name}"`, async () => { await unanchor(); setFavorited(false); onFavorite(); });
      } else {
        await unanchor();
        offerUndo(`"${doc.name}" desancorado.`, `desancorar "${doc.name}"`, async () => { await anchor(); setFavorited(true); onFavorite(); });
      }
      onFavorite();
    } catch (e: any) {
      if (goingTo && e?.response?.status === 409) return;
      setFavorited(!goingTo);
      showError(goingTo ? "Não foi possível ancorar. Tente de novo." : "Não foi possível desancorar. Tente de novo.");
    }
  }

  async function download() {
    try {
      const r = await api.get(`/documents/${doc.id}/download-url`);
      const a = document.createElement("a");
      a.href = r.data.download_url;
      a.download = doc.name;
      a.click();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível baixar."));
    }
  }

  const s = getFileStyle(doc.name);
  const FileIcon = s.icon;
  const action = "flex flex-col items-center justify-center gap-1 h-14 pointer-coarse:h-16 rounded-(--radius-control) text-mac-caption text-(--text-primary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)";

  const body = (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <FileIcon className="w-11 h-11 shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="text-mac-body font-semibold text-(--text-primary) break-words focus:outline-hidden">{doc.name}</h2>
          <p className="text-mac-caption text-(--text-secondary) mt-0.5 break-words">{path}</p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1" role="group" aria-label="Ações do documento">
        <button onClick={onPreview} className={`${action} text-(--text-accent) font-medium`}><Eye className="w-4 h-4" aria-hidden />Abrir</button>
        <button onClick={download} className={action}><Download className="w-4 h-4" aria-hidden />Baixar</button>
        <button onClick={() => { if (!favorited) { setDropping(true); window.setTimeout(() => setDropping(false), 340); } toggleFavorite(); }} aria-pressed={favorited} className={action}>
          <Anchor className={`w-4 h-4 ${dropping ? "anchor-drop" : ""} ${favorited ? "fill-current text-(--text-accent)" : ""}`} aria-hidden />{favorited ? "Ancorado" : "Ancorar"}
        </button>
        <button onClick={(e) => onMenu(e.currentTarget)} aria-haspopup="menu" className={action}><MoreHorizontal className="w-4 h-4" aria-hidden />Mais</button>
      </div>
      {canEdit && recursos.links && (
        <button onClick={() => setSharing(true)} className="w-full flex items-center justify-center gap-2 h-9 pointer-coarse:h-11 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover)">
          <Share2 className="w-4 h-4" aria-hidden />{shareCount > 0 ? `Compartilhado em ${shareCount} ${shareCount === 1 ? "link" : "links"}` : "Compartilhar por link"}
        </button>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-mac-caption">
        <dt className="text-(--text-secondary)">Tipo</dt><dd className="text-(--text-primary) text-right">{kindLabel(doc.name)}</dd>
        <dt className="text-(--text-secondary)">Tamanho</dt><dd className="text-(--text-primary) text-right tabular-nums">{fmtSize(doc.size_bytes)}</dd>
        <dt className="text-(--text-secondary)">Enviado</dt><dd className="text-(--text-primary) text-right">{fmtDateFull(doc.created_at)}{doc.uploaded_by_name ? ` por ${doc.uploaded_by_name}` : ""}</dd>
        {doc.updated_at && <><dt className="text-(--text-secondary)">Modificado</dt><dd className="text-(--text-primary) text-right">{fmtDateFull(doc.updated_at)}</dd></>}
        <dt className="text-(--text-secondary)">Texto</dt><dd className="text-right">{ocrBadge(doc.ocr_status)}</dd>
      </dl>
      {doc.ocr_status === "failed" && canEdit && (
        <button onClick={() => api.post(`/documents/${doc.id}/retry-ocr`).then(() => { success("O texto vai ser lido de novo."); onChanged(); }).catch((e) => showError(friendlyError(e, "Não foi possível pôr na fila.")))}
          className="w-full h-9 pointer-coarse:h-11 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover)">
          Ler o texto de novo
        </button>
      )}

      <DocumentCheckout docId={doc.id} canEdit={canEdit} onChanged={onChanged} />
      <DocumentNfe docId={doc.id} name={doc.name} />
      <MetadataSection doc={doc} companyId={companyId} canEdit={canEdit} onSaved={(fid, v) => onFieldSaved(doc.id, fid, v)} />
      <Disclosure icon={<Clock className="w-4 h-4" aria-hidden />} title="Atividade"
        summary={act ? (act.total ? `${act.total} ${act.total === 1 ? "evento" : "eventos"} · último ${relativeDate(act.last ?? "")}` : "sem eventos") : undefined}>
        <DocActivity companyId={companyId} docId={doc.id} />
        <LinkAccesses documentId={doc.id} />
        <Link to={`/activity?item=${doc.id}&nome=${encodeURIComponent(doc.name)}`} className="mt-2 inline-flex items-center gap-1 min-h-6 pointer-coarse:min-h-11 text-mac-caption font-medium text-(--text-accent) hover:underline">
          Ver tudo na Atividade <ChevronRight className="w-3.5 h-3.5" aria-hidden />
        </Link>
      </Disclosure>
      <IntegrityCheck key={doc.id} documentId={doc.id} />
      <VersionsPanel documentId={doc.id} documentName={doc.name} onChanged={onChanged} />
      <DocumentRetentionSection docId={doc.id} />
      {recursos.obrigacoes && <DocumentObligations docId={doc.id} />}
    </div>
  );

  const shareModal = sharing && (
    <ShareModal resourceType="document" resourceId={doc.id} name={doc.name} onClose={() => setSharing(false)} onChanged={setShareCount} />
  );

  if (variant === "panel") {
    // Painel lateral persistente (não modal), entra deslizando (A5-05).
    return (
      <aside aria-label={`Detalhes de ${doc.name}`} className="panel-in hidden lg:flex flex-col w-[320px] shrink-0 border-l border-(--separator) bg-(--window-bg) overflow-hidden">
        <div className="flex items-center justify-between px-5 h-12 border-b border-(--border-default) shrink-0">
          <p className="text-mac-body font-semibold text-(--text-secondary)">Detalhes</p>
          <button onClick={onClose} aria-label="Fechar detalhes" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)">
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{body}</div>
        {shareModal}
      </aside>
    );
  }

  return (
    <>
      <Dialog onClose={onClose} title={`Detalhes de ${doc.name}`} hideTitle size="md">{body}</Dialog>
      {shareModal}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
