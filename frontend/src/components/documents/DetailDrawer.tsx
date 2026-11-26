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
  Check,
} from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dropdown from "@/components/ui/Dropdown";
import VersionsPanel from "@/components/documents/VersionsPanel";
import ActivityFeed from "@/components/shared/ActivityFeed";
import { StatusChip, type Instance } from "@/components/obligations/shared";
import ShareModal from "@/components/documents/ShareModal";
import Dialog from "@/components/ui/Dialog";
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
          className="w-full flex items-center justify-between gap-2 min-h-9 pointer-coarse:min-h-11 rounded-[6px] text-mac-body text-(--text-primary) hover:text-(--text-accent)"
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
    try {
      await api.put(`/documents/${doc.id}/field-values`, [{ custom_field_id: f.custom_field_id, value: trimmed }], { params: { company_id: companyId } });
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
  const visible = fields.filter((f) => !f.condition_field_id || (values[f.condition_field_id] ?? "") === (f.condition_value ?? ""));
  if (visible.length === 0) return null;

  return (
    <section aria-labelledby={`${uid}-meta`} className="border-t border-(--border-default) pt-3 space-y-3">
      <h3 id={`${uid}-meta`} className="text-mac-body font-semibold text-(--text-primary)">Metadados</h3>
      {visible.map((f) => {
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
              <span aria-live="polite"><FieldStatusIndicator status={status} message={status === "error" ? "não salvou" : undefined} /></span>
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
    </section>
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

export function DetailDrawer({ doc, companyId, variant = "modal", path, canEdit, onClose, onFavorite, onPreview, onMenu, onChanged, onFieldSaved }: {
  doc: Document; companyId: string; variant?: "modal" | "panel"; path: string; canEdit: boolean;
  onClose: () => void; onFavorite: () => void; onPreview: () => void; onMenu: (el: HTMLElement) => void; onChanged: () => void;
  onFieldSaved: (docId: string, fieldId: string, value: string) => void;
}) {
  const { success, error: showError } = useToast();
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
      if (goingTo) { await api.post("/favorites", { document_id: doc.id }); success(`"${doc.name}" ancorado.`); }
      else {
        const list = await api.get<{ id: string; document_id: string | null }[]>("/favorites");
        const id = list.data.find((f) => f.document_id === doc.id)?.id;
        if (id) await api.delete(`/favorites/${id}`);
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
        <div className={`w-11 h-11 rounded-(--radius-control) flex items-center justify-center shrink-0 ${s.bgColor}`}>
          <FileIcon className={`w-5 h-5 ${s.iconColor} ${s.fillColor}`} aria-hidden />
        </div>
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
      {canEdit && (
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

      <MetadataSection doc={doc} companyId={companyId} canEdit={canEdit} onSaved={(fid, v) => onFieldSaved(doc.id, fid, v)} />
      <Disclosure icon={<Clock className="w-4 h-4" aria-hidden />} title="Atividade"
        summary={act ? (act.total ? `${act.total} ${act.total === 1 ? "evento" : "eventos"} · último ${relativeDate(act.last ?? "")}` : "sem eventos") : undefined}>
        <ActivityFeed companyId={companyId} itemId={doc.id} pageSize={20} groupByDay={false} emptyDescription="Nenhuma atividade registrada neste documento ainda." />
        <LinkAccesses documentId={doc.id} />
        <Link to={`/activity?item=${doc.id}&nome=${encodeURIComponent(doc.name)}`} className="mt-2 inline-flex items-center gap-1 min-h-6 pointer-coarse:min-h-11 text-mac-caption font-medium text-(--text-accent) hover:underline">
          Ver tudo na Atividade <ChevronRight className="w-3.5 h-3.5" aria-hidden />
        </Link>
      </Disclosure>
      <IntegrityCheck key={doc.id} documentId={doc.id} />
      <VersionsPanel documentId={doc.id} documentName={doc.name} onChanged={onChanged} />
      <DocumentRetentionSection docId={doc.id} />
      <DocumentObligations docId={doc.id} />
    </div>
  );

  const shareModal = sharing && (
    <ShareModal resourceType="document" resourceId={doc.id} name={doc.name} onClose={() => setSharing(false)} onChanged={setShareCount} />
  );

  if (variant === "panel") {
    // Painel lateral persistente (não modal), entra deslizando (A5-05).
    return (
      <aside aria-label={`Detalhes de ${doc.name}`} className="panel-in hidden lg:flex flex-col w-[340px] shrink-0 border-l border-(--border-default) overflow-hidden">
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
