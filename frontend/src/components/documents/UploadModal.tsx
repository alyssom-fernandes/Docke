import { useEffect, useRef, useState } from "react";
import { getFileStyle } from "@/lib/fileType";
import { Folder, Upload, X, FolderUp, Camera } from "lucide-react";
import api from "@/lib/api";
import { useTaskCenter } from "@/lib/TaskContext";
import { useCompany } from "@/lib/CompanyContext";
import Checkbox from "@/components/ui/Checkbox";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import CameraCapture from "@/components/documents/CameraCapture";
import Dialog from "@/components/ui/Dialog";
import FolderPickerDialog from "@/components/documents/FolderPickerDialog";
import { friendlyError } from "@/lib/errors";
import { fmtSize, ALLOWED_EXT, MAX_UPLOAD_BYTES, plural, putWithProgress, CANCELADO, type DocFolder } from "@/components/documents/docShared";

export interface PendingFile {
  file: File;
  // Cadeia de subpastas em que o arquivo estava no drop de pasta local
  // (ex: "NotasFiscais/2026"); vazio pra seleção manual de arquivo solto.
  relativePath: string;
}

// Lê recursivamente uma FileSystemEntry (webkitGetAsEntry) reconstruindo a
// hierarquia de diretórios — padrão usado por Box/Dropbox/Drive/Egnyte pra
// upload de pasta local via drag-and-drop (ADENDO-09 §13.3 Tier 1 item 6).
export async function walkEntry(entry: any, currentPath: string, collected: PendingFile[]): Promise<void> {
  if (entry.isFile) {
    await new Promise<void>((resolve) => {
      entry.file((file: File) => { collected.push({ file, relativePath: currentPath }); resolve(); });
    });
  } else if (entry.isDirectory) {
    const newPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    const reader = entry.createReader();
    // readEntries() não garante retornar tudo numa chamada só — precisa
    // repetir até vir vazio (particularidade documentada da API).
    const children: any[] = [];
    for (;;) {
      const batch: any[] = await new Promise((resolve) => reader.readEntries(resolve));
      if (!batch.length) break;
      children.push(...batch);
    }
    for (const child of children) {
      await walkEntry(child, newPath, collected);
    }
  }
}

// Acompanha o OCR de um lote recém-enviado por polling, atualizando cada
// tarefa no Task Center até todas saírem de pending/processing (ou até um
// teto de tentativas, pra não ficar girando pra sempre se algo travar).
export function pollOcrStatus(items: { documentId: string; taskId: string; fileName: string }[], updateTask: ReturnType<typeof useTaskCenter>["updateTask"]) {
  const MAX_ATTEMPTS = 20; // ~60s a 3s por tentativa
  let attempts = 0;
  const pending = new Map(items.map((i) => [i.documentId, i]));

  const tick = async () => {
    if (pending.size === 0 || attempts >= MAX_ATTEMPTS) {
      // o que sobrar sem resolução (timeout) fica marcado como concluído sem
      // mais detalhes — o ícone de OCR na tabela é a fonte de verdade real.
      for (const { taskId, fileName } of pending.values()) updateTask(taskId, { status: "done", label: fileName });
      return;
    }
    attempts++;
    try {
      const { data } = await api.get<{ id: string; ocr_status: string }[]>("/documents/ocr-status", {
        params: { document_ids: Array.from(pending.keys()).join(",") },
      });
      for (const row of data) {
        const item = pending.get(row.id);
        if (!item) continue;
        if (row.ocr_status === "done") {
          updateTask(item.taskId, { status: "done", label: `${item.fileName} · disponível na busca` });
          pending.delete(row.id);
        } else if (row.ocr_status === "failed") {
          updateTask(item.taskId, { status: "failed", error: `${item.fileName}: falha ao extrair texto (OCR).` });
          pending.delete(row.id);
        } else {
          updateTask(item.taskId, { label: `${item.fileName} · extraindo texto…` });
        }
      }
    } catch {
      // erro de rede na sondagem não derruba a tarefa — só tenta de novo no próximo tick
    }
    if (pending.size > 0) setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

// Sessões de envio em partes guardadas no aparelho (FA-A4-04). Valem 5 h: a
// limpeza do servidor apaga envios incompletos com mais de 6 h.
interface SessaoEnvio { documentId: string; uploadId: string; partSize: number; totalParts: number; parts: { part_number: number; etag: string }[]; savedAt: number }
const SESSOES_KEY = "docke_upload_sessions";
const SESSAO_VALIDADE_MS = 5 * 3600 * 1000;
function sessaoChave(file: File, folderId: string) { return `${folderId}|${file.name}|${file.size}|${file.lastModified}`; }
function todasSessoes(): Record<string, SessaoEnvio> {
  try { return JSON.parse(localStorage.getItem(SESSOES_KEY) ?? "{}"); } catch { return {}; }
}
function lerSessao(fp: string): SessaoEnvio | null {
  const s = todasSessoes()[fp];
  return s && Date.now() - s.savedAt < SESSAO_VALIDADE_MS ? s : null;
}
function gravarSessao(fp: string, s: SessaoEnvio) {
  const all = todasSessoes();
  for (const [k, v] of Object.entries(all)) if (Date.now() - v.savedAt >= SESSAO_VALIDADE_MS) delete all[k];
  all[fp] = s;
  try { localStorage.setItem(SESSOES_KEY, JSON.stringify(all)); } catch { /* sem espaço: segue sem retomar */ }
}
function apagarSessao(fp: string) {
  const all = todasSessoes();
  delete all[fp];
  try { localStorage.setItem(SESSOES_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

export function UploadModal({ folderId, folderName, companyId, onClose, onDone, initialFiles }: { folderId: string | null; folderName: string; companyId: string; onClose: () => void; onDone: () => void; initialFiles?: File[] }) {
  // Importação de acervo (B4.3.7): o admin pode manter a data original de cada arquivo.
  const { current: empresaAtual } = useCompany();
  const podeDataOriginal = empresaAtual?.permission_level === "admin" || empresaAtual?.permission_level === "supremo";
  const [dataOriginal, setDataOriginal] = useState(false);
  // Resposta da confirmação de cada documento (ex.: mesma chave de NF-e — B1.1.5).
  const confirmacoes = useRef(new Map<string, { mesma_chave?: { id: string; name: string; folder_id: string | null } }>());
  const { success, warning, info } = useToast();
  const { addTask, updateTask, registerRetry, registerCancel, registerPause } = useTaskCenter();
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [dragOver, setDragOver] = useState(false);
  const [dest, setDest] = useState<{ id: string | null; name: string }>({ id: folderId, name: folderName });
  const [picking, setPicking] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState(false);

  // Arquivos que chegaram pelo "Compartilhar" do celular (B4.5.7).
  useEffect(() => {
    if (initialFiles?.length) addFiles(initialFiles.map((file) => ({ file, relativePath: "" })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles]);

  // Escolher uma pasta inteira pelo botão (antes só arrastando — achado A4-52).
  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  // Valida antes de enviar (achado A4-53): extensão, tamanho, vazio e repetido.
  function addFiles(items: PendingFile[]) {
    const ok: PendingFile[] = [];
    const bad: { name: string; reason: string }[] = [];
    const seen = new Set(pending.map((p) => `${p.relativePath}/${p.file.name}`.toLowerCase()));
    for (const it of items) {
      const label = it.relativePath ? `${it.relativePath}/${it.file.name}` : it.file.name;
      const ext = it.file.name.split(".").pop()?.toLowerCase() ?? "";
      if (it.file.name.startsWith(".") || ext === "ds_store" || it.file.name === "Thumbs.db") continue;
      if (!ALLOWED_EXT.includes(ext)) bad.push({ name: label, reason: "tipo não aceito" });
      else if (it.file.size === 0) bad.push({ name: label, reason: "arquivo vazio" });
      else if (it.file.size > MAX_UPLOAD_BYTES) bad.push({ name: label, reason: "passa de 200 MB" });
      else if (seen.has(label.toLowerCase())) continue;
      else { seen.add(label.toLowerCase()); ok.push(it); }
    }
    setPending((prev) => [...prev, ...ok]);
    if (bad.length) setRejected((prev) => [...prev, ...bad]);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.items;
    if (!items || !items.length) return;
    const collected: PendingFile[] = [];
    const entries = Array.from(items).map((it) => (it as any).webkitGetAsEntry?.()).filter(Boolean);
    for (const entry of entries) await walkEntry(entry, "", collected);
    addFiles(collected);
  }

  // Subpasta do arquivo → id, reaproveitando a pasta que já existe com o mesmo
  // nome (antes, reenviar uma pasta criava outra árvore com os mesmos nomes).
  async function resolveFolderId(path: string, cache: Map<string, string>): Promise<string> {
    if (!path) return cache.get("")!;
    if (cache.has(path)) return cache.get(path)!;
    let parentPath = "";
    let parentId = cache.get("")!;
    for (const seg of path.split("/")) {
      const currentPath = parentPath ? `${parentPath}/${seg}` : seg;
      if (!cache.has(currentPath)) {
        const { data: children } = await api.get<DocFolder[]>("/folders", { params: { company_id: companyId, parent_id: parentId } });
        let found = children.find((c) => c.name.toLowerCase() === seg.trim().toLowerCase());
        if (!found) {
          try {
            const { data } = await api.post("/folders", { name: seg, company_id: companyId, parent_id: parentId });
            found = data;
          } catch (err: any) {
            if (err?.response?.status !== 409) throw err;
            const { data: again } = await api.get<DocFolder[]>("/folders", { params: { company_id: companyId, parent_id: parentId } });
            found = again.find((c) => c.name.toLowerCase() === seg.trim().toLowerCase());
            if (!found) throw err;
          }
        }
        cache.set(currentPath, found!.id);
      }
      parentId = cache.get(currentPath)!;
      parentPath = currentPath;
    }
    return parentId;
  }

  // Fase 11.1: acima disso, upload em partes (multipart) em vez de um PUT
  // único — mesmo threshold do backend (documents.py::_MULTIPART_THRESHOLD).
  const MULTIPART_THRESHOLD = 20 * 1024 * 1024;
  const PAUSADO = "__pausado__";

  async function uploadFileMultipart(
    file: File, targetFolderId: string, onProgress: (label: string, progress: number) => void, signal?: AbortSignal, novoEnvio = false,
    pausa?: { pausado: boolean },
  ): Promise<string> {
    // Envio retomável (FA-A4-04): a sessão (documento, upload e partes já
    // confirmadas) fica guardada no aparelho; se a conexão cair, "Tentar de
    // novo" ou escolher o mesmo arquivo depois continua das partes que faltam.
    const fp = sessaoChave(file, targetFolderId);
    const salva = novoEnvio ? null : lerSessao(fp);
    let sess: SessaoEnvio;
    if (salva) {
      sess = salva;
      onProgress(`${file.name}`, Math.round((sess.parts.length / sess.totalParts) * 100));
    } else {
      const { data: created } = await api.post("/documents/multipart/create", {
        folder_id: targetFolderId,
        company_id: companyId,
        name: file.name,
        size_bytes: file.size,
        content_type: file.type || "application/octet-stream",
        original_created_at: dataOriginal && file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
      });
      sess = { documentId: created.document_id, uploadId: created.upload_id, partSize: created.part_size, totalParts: created.total_parts, parts: [], savedAt: Date.now() };
      gravarSessao(fp, sess);
    }
    const { documentId, uploadId, partSize, totalParts } = sess;
    try {
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (signal?.aborted) throw new Error(CANCELADO);
        if (sess.parts.some((pt) => pt.part_number === partNumber)) continue;
        const start = (partNumber - 1) * partSize;
        const chunk = file.slice(start, start + partSize);
        let partUrlData: { upload_url: string };
        try {
          partUrlData = (await api.post(`/documents/multipart/${documentId}/part-url`, { upload_id: uploadId, part_number: partNumber })).data;
        } catch (e: any) {
          // Sessão vencida (a limpeza de envios incompletos já apagou): recomeça do zero.
          if (salva && [404, 409, 410].includes(e?.response?.status)) {
            apagarSessao(fp);
            return uploadFileMultipart(file, targetFolderId, onProgress, signal, true, pausa);
          }
          throw e;
        }
        const putResp = await fetch(partUrlData.upload_url, { method: "PUT", body: chunk, signal }).catch(() => null);
        if (signal?.aborted) throw new Error(CANCELADO);
        if (!putResp || !putResp.ok) throw new Error(`A conexão caiu durante o envio. O que já subiu (${Math.round((sess.parts.length / totalParts) * 100)}%) fica guardado: tente de novo para continuar de onde parou.`);
        const etag = putResp.headers.get("ETag");
        if (!etag) throw new Error("O armazenamento não confirmou uma parte do arquivo. Tente de novo; se continuar, avise o administrador.");
        sess.parts.push({ part_number: partNumber, etag });
        sess.savedAt = Date.now();
        gravarSessao(fp, sess);
        onProgress(`${file.name}`, Math.round((sess.parts.length / totalParts) * 100));
      }
      const parts = [...sess.parts].sort((a, b) => a.part_number - b.part_number);
      const { data: fim } = await api.post(`/documents/multipart/${documentId}/complete`, { upload_id: uploadId, parts });
      confirmacoes.current.set(documentId, fim ?? {});
      apagarSessao(fp);
      return documentId;
    } catch (err) {
      // Cancelado por quem enviou: descarta. Pausado ou queda de conexão:
      // guarda as partes para continuar depois (A4-58).
      if (err instanceof Error && err.message === CANCELADO && !pausa?.pausado) {
        apagarSessao(fp);
        try { await api.post(`/documents/multipart/${documentId}/abort`, { upload_id: uploadId }); } catch { /* ignore */ }
      }
      throw err;
    }
  }

  async function attemptUploadOne(
    file: File, relativePath: string, targetFolderId: string, taskId: string, displayName: string,
  ): Promise<{ ok: true; documentId: string; taskId: string; fileName: string } | { ok: false; reason: string }> {
    updateTask(taskId, { status: "running", phase: "uploading", error: undefined, progress: 0, label: displayName });
    const controller = new AbortController();
    registerCancel(taskId, () => controller.abort());
    const pausa = { pausado: false };
    try {
      let documentId: string;
      if (file.size >= MULTIPART_THRESHOLD) {
        // Só o envio em partes pode pausar: as partes confirmadas ficam guardadas.
        updateTask(taskId, { paused: false });
        registerPause(taskId, () => { pausa.pausado = true; controller.abort(); });
        documentId = await uploadFileMultipart(file, targetFolderId, (label, p) => updateTask(taskId, { label, progress: p }), controller.signal, false, pausa);
        registerPause(taskId, null);
      } else {
        const { data } = await api.post("/documents/upload-url", {
          folder_id: targetFolderId,
          company_id: companyId,
          name: file.name,
          size_bytes: file.size,
          content_type: file.type || "application/octet-stream",
          original_created_at: dataOriginal && file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
        });
        // Mesmo tipo da assinatura da URL (o Chrome chama XML de text/xml e a
        // URL vem assinada com application/xml — achado X2-03).
        const status = await putWithProgress(data.upload_url, file, data.content_type ?? (file.type || "application/octet-stream"),
          (p) => updateTask(taskId, { progress: p }), controller.signal);
        if (status < 200 || status >= 300) {
          api.post(`/documents/${data.document_id}/abort-upload`).catch(() => {});
          throw new Error(status === -1 ? CANCELADO : status === 0
            ? "A conexão caiu durante o envio. Confira a internet e tente de novo."
            : `O armazenamento recusou o arquivo (código ${status}). Tente de novo; se continuar, avise o administrador.`);
        }
        const { data: conf } = await api.post(`/documents/${data.document_id}/confirm`);
        confirmacoes.current.set(data.document_id, conf ?? {});
        documentId = data.document_id;
      }
      registerCancel(taskId, null);
      updateTask(taskId, { label: `${displayName} · lendo o texto…`, phase: "processing", progress: undefined });
      pollOcrStatus([{ documentId, taskId, fileName: displayName }], updateTask);
      // B1.1.5: a mesma nota (mesma chave de 44 dígitos) já estava na empresa.
      const outra = confirmacoes.current.get(documentId)?.mesma_chave;
      if (outra) {
        const novoId = documentId;
        updateTask(taskId, { aviso: {
          texto: `A mesma nota já está na empresa: "${outra.name}".`,
          acoes: [
            { label: "Juntar como nova versão", run: async () => {
              try {
                const r = await api.post(`/documents/${novoId}/juntar`, { destino_id: outra.id });
                updateTask(taskId, { aviso: undefined, label: `${displayName} · virou a versão ${r.data.version_number} de "${outra.name}"` });
                onDone();
              } catch (e) { updateTask(taskId, { aviso: { texto: friendlyError(e, "Não foi possível juntar."), acoes: [] } }); }
            } },
            { label: "Manter os dois", run: () => updateTask(taskId, { aviso: undefined }) },
          ],
        } });
      }
      return { ok: true, documentId, taskId, fileName: displayName };
    } catch (fileErr: any) {
      registerCancel(taskId, null);
      registerPause(taskId, null);
      if (pausa.pausado) {
        const t = `Pausado. Continue quando quiser: o que já subiu fica guardado neste aparelho.`;
        updateTask(taskId, { status: "failed", paused: true, error: t });
        registerRetry(taskId, () => { attemptUploadOne(file, relativePath, targetFolderId, taskId, displayName); });
        return { ok: false, reason: PAUSADO };
      }
      const reason = fileErr?.response ? friendlyError(fileErr, "Não foi possível enviar.") : (fileErr?.message ?? "Não foi possível enviar.");
      updateTask(taskId, { status: "failed", error: reason });
      registerRetry(taskId, () => { attemptUploadOne(file, relativePath, targetFolderId, taskId, displayName); });
      return { ok: false, reason };
    }
  }

  async function upload() {
    if (!pending.length) return;
    if (!dest.id) { setPicking(true); return; }
    setUploading(true);
    setProgress({ done: 0, total: pending.length, failed: 0 });
    const folderCache = new Map<string, string>([["", dest.id]]);
    const failures: { name: string; reason: string }[] = [];
    let okCount = 0;
    let pausados = 0;
    // Lote no servidor (B1.1.9): consultável depois, mesmo se a aba fechar.
    const lote = pending.length > 1
      ? await api.post<{ id: string }>("/upload-batches", { company_id: companyId, folder_id: dest.id, folder_name: dest.name, total: pending.length, data_original: dataOriginal })
          .then((r) => r.data.id).catch(() => null)
      : null;
    // Três envios ao mesmo tempo (antes, um arquivo e uma parte por vez — A4-55).
    const queue = [...pending];
    async function worker() {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const displayName = item.relativePath ? `${item.relativePath}/${item.file.name}` : item.file.name;
        const taskId = addTask({ kind: "upload", label: displayName, status: "running", phase: "uploading" });
        let result: Awaited<ReturnType<typeof attemptUploadOne>>;
        try {
          const target = await resolveFolderId(item.relativePath, folderCache);
          result = await attemptUploadOne(item.file, item.relativePath, target, taskId, displayName);
        } catch (err: any) {
          const reason = friendlyError(err, "Não foi possível criar a subpasta.");
          updateTask(taskId, { status: "failed", error: reason });
          result = { ok: false, reason };
        }
        if (result.ok) okCount++;
        else if (result.reason === PAUSADO) pausados++;
        else failures.push({ name: displayName, reason: result.reason });
        setProgress((p) => ({ ...p, done: p.done + 1, failed: failures.length }));
      }
    }
    try {
      await Promise.all([worker(), worker(), worker()]);
      if (lote) {
        api.patch(`/upload-batches/${lote}`, { ok: okCount, concluido: true, falhas: failures.map((f) => ({ nome: f.name.slice(0, 600), motivo: f.reason.slice(0, 600) })) }).catch(() => {});
      }
      if (okCount > 0) success(`${plural(okCount, "arquivo enviado", "arquivos enviados")} para "${dest.name}".`);
      if (pausados > 0) info(`${plural(pausados, "envio pausado", "envios pausados")}: continue pela Central de tarefas.`);
      if (failures.length > 0) {
        warning(`${plural(failures.length, "arquivo não foi enviado", "arquivos não foram enviados")}. Na Central de tarefas dá para ver o motivo e tentar de novo.`);
      }
      onDone();
      if (failures.length === 0) onClose();
      else setPending((prev) => prev.filter((p) => failures.some((f) => f.name === (p.relativePath ? `${p.relativePath}/${p.file.name}` : p.file.name))));
    } finally {
      setUploading(false);
    }
  }

  const totalBytes = pending.reduce((acc, p) => acc + p.file.size, 0);

  return (
    <>
    <Dialog
      onClose={onClose}
      title="Enviar documentos"
      description={
        <span className="flex flex-wrap items-center gap-x-1.5">
          Para:
          <span className="inline-flex items-center gap-1 font-medium text-(--text-primary)">
            <Folder className="w-3.5 h-3.5 text-(--text-accent)" aria-hidden />
            {dest.id ? dest.name : "escolha uma pasta"}
          </span>
          <button type="button" onClick={() => setPicking(true)} disabled={uploading}
            className="text-(--text-accent) font-medium underline-offset-2 hover:underline disabled:opacity-(--opacity-disabled) min-h-6 pointer-coarse:min-h-11">
            {dest.id ? "Trocar" : "Escolher"}
          </button>
        </span>
      }
      size="md"
      busy={uploading}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={uploading}>Cancelar</Button>
          <Button loading={uploading} onClick={upload} disabled={!pending.length}>
            {uploading ? `Enviando ${Math.min(progress.done + 1, progress.total)} de ${progress.total}…` : pending.length ? `Enviar ${plural(pending.length, "arquivo", "arquivos")}` : "Enviar"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {camera && <CameraCapture onClose={() => setCamera(false)} onReady={(file) => addFiles([{ file, relativePath: "" }])} />}
        {podeDataOriginal && (
          <label className="flex items-start gap-2 text-mac-caption text-(--text-secondary)">
            <Checkbox checked={dataOriginal} disabled={uploading} onChange={(e) => setDataOriginal(e.target.checked)} className="mt-0.5" />
            <span><span className="font-medium text-(--text-primary)">Importação de acervo: manter a data original de cada arquivo.</span> Use ao trazer documentos de outro sistema. O resultado do envio fica em Envios anteriores, na central de tarefas, com o relatório do que entrou e do que não entrou.</span>
          </label>
        )}
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`block border-2 border-dashed rounded-(--radius-control) px-5 py-7 text-center cursor-pointer transition-colors duration-fast focus-within:ring-[3px] focus-within:ring-(--focus-ring) ${
            dragOver ? "border-teal-500 bg-(--tint-accent)" : "border-(--border-control) hover:border-teal-500"
          }`}
        >
          <Upload className="w-7 h-7 text-(--text-accent) mx-auto mb-2" aria-hidden />
          <p className="text-mac-body text-(--text-primary)">Arraste arquivos ou pastas para cá, ou clique para escolher</p>
          <p className="text-mac-caption text-(--text-secondary) mt-1">PDF, Word, Excel, CSV, XML (NF-e), TXT, JPG, PNG e GIF · até 200 MB cada · a pasta arrastada vem com as subpastas</p>
          <input
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => { addFiles(Array.from(e.target.files ?? []).map((file) => ({ file, relativePath: "" }))); e.target.value = ""; }}
            accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.xml,.jpg,.jpeg,.png,.gif,.txt"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => folderInputRef.current?.click()} disabled={uploading}>
            <FolderUp className="w-3.5 h-3.5" aria-hidden /> Escolher uma pasta inteira
          </Button>
          {/* Captura pela câmera (B1.1.7): fotos viram um PDF. */}
          <Button variant="secondary" size="sm" type="button" onClick={() => setCamera(true)} disabled={uploading}>
            <Camera className="w-3.5 h-3.5" aria-hidden /> Digitalizar com a câmera
          </Button>
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []).map((file) => {
                const rel = (file as any).webkitRelativePath as string | undefined;
                return { file, relativePath: rel ? rel.split("/").slice(0, -1).join("/") : "" };
              }));
              e.target.value = "";
            }}
          />
        </div>
        {pending.length > 0 && (
          <div>
            <p className="mb-1.5 text-mac-caption text-(--text-secondary)" aria-live="polite">
              {plural(pending.length, "arquivo", "arquivos")} · {fmtSize(totalBytes)}
              {uploading && progress.failed > 0 && ` · ${plural(progress.failed, "falha", "falhas")}`}
            </p>
            <ul className="max-h-44 overflow-y-auto rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)">
              {pending.map((p, i) => {
                const st = getFileStyle(p.file.name);
                const Icon = st.icon;
                const label = p.relativePath ? `${p.relativePath}/${p.file.name}` : p.file.name;
                return (
                  <li key={`${label}-${i}`} className="flex items-center gap-2 px-2.5 h-9 pointer-coarse:h-11 text-mac-caption text-(--text-secondary)">
                    <Icon className="w-5 h-5 shrink-0" aria-hidden />
                    <span className="flex-1 truncate text-(--text-primary)" title={label}>{label}</span>
                    <span className="shrink-0 tabular-nums">{fmtSize(p.file.size)}</span>
                    <button type="button" onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))} disabled={uploading}
                      aria-label={`Tirar ${label} da lista`}
                      className="w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 -mr-1 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) disabled:opacity-(--opacity-disabled)">
                      <X className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {rejected.length > 0 && (
          <div role="status" className="rounded-(--radius-control) border border-amber-500/30 bg-(--tint-warning) px-3 py-2 text-mac-caption text-(--text-primary)">
            <p className="font-medium">{plural(rejected.length, "arquivo ficou de fora", "arquivos ficaram de fora")}:</p>
            <ul className="mt-1 max-h-20 overflow-y-auto space-y-0.5 text-(--text-secondary)">
              {rejected.map((r, i) => <li key={i} className="truncate">{r.name} — {r.reason}</li>)}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
    {picking && (
      <FolderPickerDialog
        companyId={companyId}
        title="Enviar para qual pasta?"
        confirmLabel="Usar esta pasta"
        initialId={dest.id}
        onPick={(f) => { setDest({ id: f.id, name: f.name }); setPicking(false); }}
        onClose={() => setPicking(false)}
      />
    )}
    </>
  );
}

// ─── Create Folder Modal ──────────────────────────────────────────────────────
