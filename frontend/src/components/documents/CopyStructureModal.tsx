import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Folder, Home, Loader2, Search, Info, Ban } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { useTaskCenter } from "@/lib/TaskContext";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Dropdown from "@/components/ui/Dropdown";
import Checkbox from "@/components/ui/Checkbox";

interface FolderOption {
  id: string;
  name: string;
  parent_id: string | null;
  depth: number;
  trail: string;
}

interface Preview {
  folders: number;
  root_name: string;
  root_renamed: boolean;
  documents: number;
  documents_bytes: number;
  field_applications: number;
  fields_new: number;
  fields_reused: number;
  sensitive_folders: number;
  same_company: boolean;
  access_grants: number;
  retention_assignments: number;
}

interface Pair { source_folder_id: string; target_folder_id: string }

// Achata a árvore vinda de /folders?flat=true em uma lista já ordenada por
// profundidade (pai sempre antes dos filhos), com o caminho para a busca.
function buildFlatOptions(raw: Array<{ id: string; name: string; parent_id: string | null }>): FolderOption[] {
  const byParent = new Map<string | null, typeof raw>();
  raw.forEach((f) => {
    const key = f.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(f);
  });
  const result: FolderOption[] = [];
  function walk(parentId: string | null, depth: number, trail: string) {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    for (const f of children) {
      const t = trail ? `${trail} / ${f.name}` : f.name;
      result.push({ id: f.id, name: f.name, parent_id: f.parent_id, depth, trail: t });
      walk(f.id, depth + 1, t);
    }
  }
  walk(null, 0, "");
  return result;
}

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;
const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1).replace(".", ",")} KB` : `${(b / 1048576).toFixed(1).replace(".", ",")} MB`);
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const LOTE = 5; // pastas por pedido na cópia dos documentos

export default function CopyStructureModal({
  sourceFolderId,
  sourceFolderName,
  sourceCompanyId,
  onClose,
  onDone,
}: {
  sourceFolderId: string;
  sourceFolderName: string;
  sourceCompanyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { companies, current } = useCompany();
  const { success, error: showError } = useToast();
  const { addTask, updateTask, registerCancel } = useTaskCenter();

  // Só empresas onde o usuário é admin fazem sentido como destino — criar
  // pasta exige admin (mesma regra de POST /folders).
  const targetableCompanies = companies.filter((c) => c.permission_level === "admin");

  const [targetCompanyId, setTargetCompanyId] = useState(
    targetableCompanies.some((c) => c.id === current?.id) ? current!.id : targetableCompanies[0]?.id ?? "",
  );
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [targetParentId, setTargetParentId] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [includeDocuments, setIncludeDocuments] = useState(false);
  const [includePrivacy, setIncludePrivacy] = useState(true);
  const [includeAccess, setIncludeAccess] = useState(false);
  const [includeRetention, setIncludeRetention] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const sameCompany = targetCompanyId === sourceCompanyId;

  useEffect(() => {
    if (!targetCompanyId) { setFolderOptions([]); return; }
    setLoadingFolders(true);
    setTargetParentId(null);
    setFiltro("");
    api.get("/folders", { params: { company_id: targetCompanyId, flat: true } })
      .then((r) => setFolderOptions(buildFlatOptions(Array.isArray(r.data) ? r.data : [])))
      .catch(() => setFolderOptions([]))
      .finally(() => setLoadingFolders(false));
  }, [targetCompanyId]);

  // Prévia (A4-47): o servidor conta o que vai ser criado, sem gravar nada.
  useEffect(() => {
    if (!targetCompanyId) return;
    let vivo = true;
    setPreview(null);
    setPreviewFailed(false);
    const t = window.setTimeout(() => {
      api.post<Preview>(`/folders/${sourceFolderId}/copy-structure/preview`, {
        target_company_id: targetCompanyId, target_parent_id: targetParentId,
      })
        .then((r) => { if (vivo) setPreview(r.data); })
        .catch(() => { if (vivo) setPreviewFailed(true); });
    }, 200);
    return () => { vivo = false; window.clearTimeout(t); };
  }, [sourceFolderId, targetCompanyId, targetParentId]);

  // Copiar pra dentro da própria pasta (ou de um descendente) na mesma
  // empresa não faz sentido — o backend também bloqueia.
  const disabledFolderIds = useMemo(() => {
    const s = new Set<string>();
    if (!sameCompany) return s;
    const marcar = (id: string) => { s.add(id); folderOptions.filter((f) => f.parent_id === id).forEach((f) => marcar(f.id)); };
    marcar(sourceFolderId);
    return s;
  }, [folderOptions, sameCompany, sourceFolderId]);

  const q = semAcento(filtro.trim());
  const visiveis = q ? folderOptions.filter((f) => semAcento(f.trail).includes(q)) : folderOptions;
  // Opções navegáveis por seta (A4-49): raiz + pastas visíveis que aceitam a cópia.
  const navegaveis: (string | null)[] = [null, ...visiveis.filter((f) => !disabledFolderIds.has(f.id)).map((f) => f.id)];

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = navegaveis.indexOf(targetParentId);
    const n = e.key === "Home" ? 0 : e.key === "End" ? navegaveis.length - 1
      : Math.max(0, Math.min(navegaveis.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    const alvo = navegaveis[n];
    setTargetParentId(alvo);
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-opt="${alvo ?? "raiz"}"]`)?.focus();
    });
  }

  async function copiarDocumentos(pairs: Pair[], destinoNome: string) {
    const taskId = addTask({ kind: "copy", label: `Copiando documentos para “${destinoNome}”`, status: "running", progress: 0 });
    let cancelado = false;
    registerCancel(taskId, () => { cancelado = true; });
    let copiados = 0;
    try {
      for (let i = 0; i < pairs.length; i += LOTE) {
        if (cancelado) break;
        const { data } = await api.post<{ documents_copied: number }>("/folders/copy-documents", {
          target_company_id: targetCompanyId, pairs: pairs.slice(i, i + LOTE),
        });
        copiados += data.documents_copied;
        updateTask(taskId, { progress: Math.round(((i + LOTE) / pairs.length) * 100) });
      }
      registerCancel(taskId, null);
      if (cancelado) {
        updateTask(taskId, { status: "failed", error: `Cancelado: ${plural(copiados, "documento copiado", "documentos copiados")} antes de parar.` });
      } else {
        updateTask(taskId, { status: "done", progress: 100, label: `${plural(copiados, "documento copiado", "documentos copiados")} para “${destinoNome}”` });
      }
      onDone();
    } catch (e: any) {
      registerCancel(taskId, null);
      updateTask(taskId, {
        status: "failed",
        error: `${e?.response?.data?.detail ?? "A cópia dos documentos parou."} ${plural(copiados, "documento foi copiado", "documentos foram copiados")}; a estrutura já está criada.`,
      });
      onDone();
    }
  }

  async function submit() {
    if (!targetCompanyId) return;
    setSubmitting(true);
    try {
      const { data } = await api.post(`/folders/${sourceFolderId}/copy-structure`, {
        target_company_id: targetCompanyId,
        target_parent_id: targetParentId,
        include_metadata: includeMetadata,
        include_documents: false,
        include_privacy: includePrivacy,
        include_access: sameCompany && includeAccess,
        include_retention: sameCompany && includeRetention,
      });
      // Relatório do que foi feito (A4-47).
      const partes = [plural(data.folders_copied, "pasta", "pastas")];
      if (data.fields_copied > 0) partes.push(plural(data.fields_copied, "campo aplicado", "campos aplicados"));
      if (data.sensitivity_copied > 0) partes.push(plural(data.sensitivity_copied, "classificação LGPD", "classificações LGPD"));
      if (data.access_copied > 0) partes.push(plural(data.access_copied, "acesso", "acessos"));
      if (data.retention_copied > 0) partes.push(plural(data.retention_copied, "regra de retenção", "regras de retenção"));
      const nome = data.root_renamed ? ` como “${data.name}” (já existia “${data.source_name}” no destino)` : "";
      success(`Estrutura copiada${nome}: ${partes.join(", ")}.${includeDocuments && (preview?.documents ?? 1) > 0 ? " Os documentos seguem na central de tarefas." : ""}`);
      onDone();
      onClose();
      if (includeDocuments && Array.isArray(data.pairs) && data.pairs.length) {
        void copiarDocumentos(data.pairs, data.name);
      }
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível copiar a estrutura. Confira o destino e tente de novo.");
    } finally {
      setSubmitting(false);
    }
  }

  const destinoNome = targetParentId ? folderOptions.find((f) => f.id === targetParentId)?.trail : "raiz da empresa";

  const resumo = (() => {
    if (previewFailed) return <span className="text-(--text-secondary)">Não foi possível calcular a prévia agora; a cópia ainda pode ser feita.</span>;
    if (!preview) return <span className="inline-flex items-center gap-1.5 text-(--text-secondary)"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Calculando o que vai ser criado…</span>;
    const p = preview;
    const itens = [plural(p.folders, "pasta", "pastas")];
    if (includeMetadata && p.field_applications) itens.push(`${plural(p.field_applications, "campo aplicado", "campos aplicados")}${p.fields_new ? ` (${plural(p.fields_new, "campo novo", "campos novos")} na empresa)` : ""}`);
    if (includeDocuments) itens.push(p.documents ? `${plural(p.documents, "documento", "documentos")} (${fmtBytes(p.documents_bytes)})` : "nenhum documento");
    if (includePrivacy && p.sensitive_folders) itens.push(plural(p.sensitive_folders, "classificação LGPD", "classificações LGPD"));
    if (sameCompany && includeAccess && p.access_grants) itens.push(plural(p.access_grants, "acesso", "acessos"));
    if (sameCompany && includeRetention && p.retention_assignments) itens.push(plural(p.retention_assignments, "regra de retenção", "regras de retenção"));
    return (
      <>
        Vai criar <strong className="font-semibold text-(--text-primary)">“{p.root_name}”</strong> em {destinoNome}: {itens.join(", ")}.
        {p.root_renamed && <> Já existe “{sourceFolderName}” lá, então o nome ganha um número.</>}
      </>
    );
  })();

  return (
    <Dialog onClose={onClose} title={`Copiar estrutura de “${sourceFolderName}”`} size="md" busy={submitting}
      footer={<><Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button><Button loading={submitting} onClick={submit} disabled={!targetCompanyId}>Copiar</Button></>}>
      <div className="space-y-4">
        {targetableCompanies.length > 1 && (
          <div>
            <label id="cs-empresa" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Empresa de destino</label>
            <Dropdown
              ariaLabelledby="cs-empresa"
              value={targetCompanyId}
              onChange={setTargetCompanyId}
              placeholder="Selecione a empresa"
              options={targetableCompanies.map((c) => ({ value: c.id, label: c.name }))}
            />
          </div>
        )}

        <div>
          <p id="cs-pasta" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Pasta de destino</p>
          {folderOptions.length > 8 && (
            <div className="relative mb-1.5">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-placeholder)" aria-hidden />
              <input
                type="search" value={filtro} onChange={(e) => setFiltro(e.target.value)}
                placeholder="Procurar pasta de destino" aria-label="Procurar pasta de destino"
                className="w-full h-8 pointer-coarse:h-11 pl-8 pr-3 rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) text-mac-body text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              />
            </div>
          )}
          <div ref={listRef} role="radiogroup" aria-labelledby="cs-pasta" onKeyDown={onListKey}
            className="border border-(--border-default) rounded-(--radius-control) max-h-[220px] overflow-y-auto bg-(--bg-card)">
            {loadingFolders ? (
              <div className="flex items-center justify-center py-6" role="status">
                <Loader2 className="w-4 h-4 animate-spin text-(--text-placeholder)" aria-hidden />
                <span className="sr-only">Carregando pastas</span>
              </div>
            ) : (
              <>
                {!q && (
                  <button
                    data-opt="raiz" role="radio" aria-checked={targetParentId === null} tabIndex={targetParentId === null ? 0 : -1}
                    onClick={() => setTargetParentId(null)}
                    className={`w-full flex items-center gap-2 h-8 pointer-coarse:h-11 px-3 text-mac-body text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring) ${
                      targetParentId === null ? "bg-teal-500/10 text-(--text-accent) font-medium" : "text-(--text-primary) hover:bg-(--bg-hover)"
                    }`}
                  >
                    <Home className="w-3.5 h-3.5 shrink-0" aria-hidden />
                    Raiz da empresa
                  </button>
                )}
                {visiveis.map((f) => {
                  const disabled = disabledFolderIds.has(f.id);
                  const sel = targetParentId === f.id;
                  return (
                    <button
                      key={f.id} data-opt={f.id}
                      role="radio" aria-checked={sel} tabIndex={sel ? 0 : -1}
                      aria-disabled={disabled || undefined}
                      onClick={() => { if (!disabled) setTargetParentId(f.id); }}
                      style={{ paddingLeft: `${12 + (q ? 0 : f.depth) * 16}px` }}
                      className={`w-full flex items-center gap-2 h-8 pointer-coarse:h-11 pr-3 text-mac-body text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring) ${
                        disabled
                          ? "text-(--text-placeholder) cursor-not-allowed"
                          : sel
                          ? "bg-teal-500/10 text-(--text-accent) font-medium"
                          : "text-(--text-primary) hover:bg-(--bg-hover)"
                      }`}
                    >
                      {disabled ? <Ban className="w-3.5 h-3.5 shrink-0" aria-hidden /> : <Folder className="w-3.5 h-3.5 shrink-0 text-(--text-accent)" aria-hidden />}
                      <span className="truncate">{q ? f.trail : f.name}</span>
                      {disabled && <span className="ml-auto shrink-0 text-mac-caption">{f.id === sourceFolderId ? "é a própria pasta" : "fica dentro dela"}</span>}
                    </button>
                  );
                })}
                {q && visiveis.length === 0 && (
                  <p className="px-3 py-4 text-mac-caption text-(--text-secondary)">Nenhuma pasta com “{filtro.trim()}”.</p>
                )}
              </>
            )}
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-mac-caption font-medium text-(--text-secondary) mb-1">O que levar junto</legend>
          <label className="flex items-start gap-2 text-mac-body text-(--text-primary) cursor-pointer">
            <Checkbox checked={includeMetadata} onChange={(e) => setIncludeMetadata(e.target.checked)} />
            <span>Campos de metadados aplicados nas pastas</span>
          </label>
          <label className="flex items-start gap-2 text-mac-body text-(--text-primary) cursor-pointer">
            <Checkbox checked={includePrivacy} onChange={(e) => setIncludePrivacy(e.target.checked)} />
            <span>Classificação LGPD (pasta com dado pessoal ou sensível continua assim)</span>
          </label>
          <label className={`flex items-start gap-2 text-mac-body ${sameCompany ? "text-(--text-primary) cursor-pointer" : "text-(--text-placeholder) cursor-not-allowed"}`}>
            <Checkbox checked={sameCompany && includeAccess} disabled={!sameCompany} onChange={(e) => setIncludeAccess(e.target.checked)} />
            <span>Mesmas pessoas e grupos com acesso{!sameCompany && " (só na mesma empresa)"}</span>
          </label>
          <label className={`flex items-start gap-2 text-mac-body ${sameCompany ? "text-(--text-primary) cursor-pointer" : "text-(--text-placeholder) cursor-not-allowed"}`}>
            <Checkbox checked={sameCompany && includeRetention} disabled={!sameCompany} onChange={(e) => setIncludeRetention(e.target.checked)} />
            <span>Regras de retenção das pastas{!sameCompany && " (só na mesma empresa)"}</span>
          </label>
          <label className="flex items-start gap-2 text-mac-body text-(--text-primary) cursor-pointer">
            <Checkbox checked={includeDocuments} onChange={(e) => setIncludeDocuments(e.target.checked)} />
            <span>Documentos (copiados em segundo plano, com progresso na central de tarefas)</span>
          </label>
        </fieldset>

        <p role="status" aria-live="polite" className="flex items-start gap-2 rounded-(--radius-control) bg-(--bg-hover) px-3 py-2 text-mac-caption text-(--text-secondary)">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-(--text-accent)" aria-hidden />
          <span>{resumo}</span>
        </p>
      </div>
    </Dialog>
  );
}
