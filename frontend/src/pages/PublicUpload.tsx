import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, Building2, CalendarClock, CheckCircle2, FolderOpen, Lock, RefreshCw, UploadCloud, X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

const API_ORIGIN = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const API_BASE = API_ORIGIN + "/api/v1";

interface Info {
  title: string; message: string | null; company_name: string; folder_name: string; expires_at: string;
  requires_password: boolean; max_files: number; received: number; allowed_extensions: string[]; max_file_mb: number;
}
type Estado = "fila" | "enviando" | "recebido" | "erro";
interface Item { id: string; file: File; estado: Estado; progresso: number; erro?: string; nome?: string }

function fmtSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

async function postJson(path: string, body: unknown) {
  const r = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(typeof data.detail === "string" ? data.detail : "Não foi possível enviar agora.") as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return data;
}

function putFile(url: string, file: File, contentType: string, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url.startsWith("/") ? API_ORIGIN + url : url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("O envio do arquivo falhou. Tente de novo.")));
    xhr.onerror = () => reject(new Error("Sem conexão durante o envio. Confira a internet e tente de novo."));
    xhr.send(file);
  });
}

/**
 * Página de quem recebe um pedido de arquivos (FA-A4-11, B3.5.8): sem conta,
 * informa o nome e manda os arquivos direto para a pasta de quem pediu.
 */
export default function PublicUpload() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [nome, setNome] = useState(() => { try { return localStorage.getItem("docke_remetente") ?? ""; } catch { return ""; } });
  const [senha, setSenha] = useState("");
  const [itens, setItens] = useState<Item[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setErro(null);
    fetch(`${API_BASE}/r/${token}/info`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Este link de envio não existe.");
        return d as Info;
      })
      .then((d) => { setInfo(d); document.title = `${d.title} · enviar arquivos pelo Docke`; })
      .catch((e) => setErro(e instanceof TypeError ? "Sem conexão com o servidor. Confira a internet e tente de novo." : e.message));
  }, [token, retry]);

  const recebidos = (info?.received ?? 0) + itens.filter((i) => i.estado === "recebido").length;
  const restam = info ? Math.max(0, info.max_files - recebidos) : 0;
  const validade = info ? new Date(info.expires_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" }) : "";

  function adicionar(lista: FileList | File[]) {
    if (!info) return;
    const aceitos: Item[] = [];
    const recusados: string[] = [];
    const pendentes = itens.filter((i) => i.estado === "fila" || i.estado === "enviando").length;
    for (const f of Array.from(lista)) {
      const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
      if (!info.allowed_extensions.includes(ext)) { recusados.push(`${f.name} (tipo não aceito)`); continue; }
      if (f.size > info.max_file_mb * 1_048_576) { recusados.push(`${f.name} (passa de ${info.max_file_mb} MB)`); continue; }
      if (aceitos.length + pendentes >= restam) { recusados.push(`${f.name} (o pedido aceita no máximo ${info.max_files} arquivos)`); continue; }
      aceitos.push({ id: `${f.name}-${f.size}-${Math.random()}`, file: f, estado: "fila", progresso: 0 });
    }
    setAviso(recusados.length ? `Ficaram de fora: ${recusados.join("; ")}.` : null);
    if (aceitos.length) setItens((xs) => [...xs, ...aceitos]);
  }

  function atualizar(id: string, patch: Partial<Item>) {
    setItens((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  async function enviar() {
    if (!info || !nome.trim() || (info.requires_password && !senha)) return;
    try { localStorage.setItem("docke_remetente", nome.trim()); } catch { /* sem armazenamento */ }
    setEnviando(true);
    for (const item of itens.filter((i) => i.estado === "fila" || i.estado === "erro")) {
      atualizar(item.id, { estado: "enviando", progresso: 0, erro: undefined });
      let documentId: string | null = null;
      try {
        const u = await postJson(`/r/${token}/upload-url`, {
          name: item.file.name, size_bytes: item.file.size, content_type: item.file.type || "application/octet-stream",
          sender_name: nome.trim(), password: senha || null,
        });
        documentId = u.document_id;
        await putFile(u.upload_url, item.file, u.content_type, (p) => atualizar(item.id, { progresso: p }));
        const c = await postJson(`/r/${token}/confirm`, { document_id: documentId, password: senha || null });
        atualizar(item.id, { estado: "recebido", progresso: 100, nome: c.name });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Não foi possível enviar.";
        atualizar(item.id, { estado: "erro", erro: msg });
        if (documentId) fetch(`${API_BASE}/r/${token}/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_id: documentId, password: senha || null }) }).catch(() => {});
        const status = (e as { status?: number }).status;
        if (status === 401 || status === 410 || status === 423) { setAviso(msg); break; }
      }
    }
    setEnviando(false);
  }

  const naFila = itens.filter((i) => i.estado === "fila" || i.estado === "erro").length;
  const tudoCerto = itens.length > 0 && itens.every((i) => i.estado === "recebido");

  return (
    <main className="relative min-h-screen overflow-hidden flex flex-col items-center px-4 py-10" style={{ background: "var(--wallpaper)" }}>
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-80 dark:opacity-100"
        style={{ background: "radial-gradient(680px circle at 16% 12%, rgba(13,148,136,0.20), transparent 55%), radial-gradient(620px circle at 84% 82%, rgba(20,184,166,0.16), transparent 55%)" }} />
      <div className="relative w-full max-w-[560px]">
        <div className="flex items-center justify-center mb-8"><div className="brand-wordmark w-[130px] h-[37px]" role="img" aria-label="Docke" /></div>
        <div className="glass-dialog glass-blur-strong rounded-(--radius-dialog) p-6 shadow-modal">
          {erro ? (
            <div role="alert" className="flex flex-col items-center text-center gap-3 py-8">
              <AlertCircle className="w-10 h-10 text-(--text-secondary)" aria-hidden="true" />
              <p className="text-mac-body text-(--text-primary) max-w-[40ch]">{erro}</p>
              {erro.startsWith("Sem conexão") && <Button variant="secondary" size="sm" onClick={() => setRetry((k) => k + 1)}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>}
            </div>
          ) : !info ? (
            <div className="space-y-3 py-4" role="status" aria-label="Carregando">
              <div className="h-5 w-2/3 rounded bg-(--bg-hover) animate-pulse" /><div className="h-24 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />
            </div>
          ) : (
            <div className="reveal space-y-6">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-(--border-default) pb-4 text-mac-caption text-(--text-secondary)">
                <span className="inline-flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" aria-hidden="true" />{info.company_name}</span>
                <span className="inline-flex items-center gap-1.5"><FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />Vai para a pasta {info.folder_name}</span>
                <span className="inline-flex items-center gap-1.5"><CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />Vale até {validade}</span>
              </div>
              <div>
                <h1 className="text-mac-title2 font-bold text-(--text-primary) wrap-break-word">{info.title}</h1>
                {info.message && <p className="mt-2 text-mac-body text-(--text-secondary) whitespace-pre-line wrap-break-word">{info.message}</p>}
              </div>

              {tudoCerto ? (
                <div role="status" className="flex flex-col items-center text-center gap-2 py-4">
                  <CheckCircle2 className="w-9 h-9 text-(--text-success)" aria-hidden="true" />
                  <p className="text-mac-body font-medium text-(--text-primary)">{itens.length === 1 ? "Arquivo recebido." : `${itens.length} arquivos recebidos.`} Obrigado, {nome.trim().split(" ")[0]}.</p>
                  <p className="text-mac-caption text-(--text-secondary)">Quem pediu já foi avisado. Você pode fechar esta página{restam > 0 ? " ou mandar mais arquivos" : ""}.</p>
                  {restam > 0 && <Button variant="secondary" size="sm" onClick={() => setItens([])}>Mandar mais arquivos</Button>}
                </div>
              ) : (
                <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); enviar(); }}>
                  <Input label="Seu nome" value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="name" required maxLength={120} placeholder="Como quem pediu vai saber que foi você" />
                  {info.requires_password && (
                    <Input label="Senha do pedido" type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="off" required
                      placeholder="Combinada com quem enviou o link" />
                  )}
                  <div
                    onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
                    onDragLeave={() => setArrastando(false)}
                    onDrop={(e) => { e.preventDefault(); setArrastando(false); adicionar(e.dataTransfer.files); }}
                    className={`rounded-(--radius-panel) border-2 border-dashed px-4 py-6 text-center transition-colors duration-fast ${arrastando ? "border-(--text-accent) bg-(--bg-hover)" : "border-(--border-control)"}`}
                  >
                    <UploadCloud className="w-8 h-8 mx-auto text-(--text-accent)" aria-hidden="true" />
                    <p className="mt-2 text-mac-body text-(--text-primary)">Arraste os arquivos para cá ou</p>
                    <Button type="button" variant="secondary" size="sm" className="mt-2" disabled={restam === 0 || enviando} onClick={() => inputRef.current?.click()}>Escolher arquivos</Button>
                    <input ref={inputRef} type="file" multiple hidden accept={info.allowed_extensions.map((e) => "." + e).join(",")}
                      onChange={(e) => { if (e.target.files) adicionar(e.target.files); e.target.value = ""; }} />
                    <p className="mt-2 text-mac-caption text-(--text-secondary)">
                      Até {info.max_file_mb} MB por arquivo · {restam === 0 ? "o pedido já recebeu todos os arquivos" : `pode mandar mais ${restam} ${restam === 1 ? "arquivo" : "arquivos"}`}
                    </p>
                  </div>
                  {aviso && <p role="alert" className="text-mac-caption text-(--text-danger)">{aviso}</p>}
                  {itens.length > 0 && (
                    <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)" aria-live="polite">
                      {itens.map((i) => (
                        <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <p className="truncate text-mac-body text-(--text-primary)">{i.nome ?? i.file.name}</p>
                            <p className={`text-mac-caption ${i.estado === "erro" ? "text-(--text-danger)" : "text-(--text-secondary)"}`}>
                              {i.estado === "fila" && `${fmtSize(i.file.size)} · na fila`}
                              {i.estado === "enviando" && `Enviando… ${i.progresso}%`}
                              {i.estado === "recebido" && "Recebido"}
                              {i.estado === "erro" && i.erro}
                            </p>
                          </div>
                          {i.estado === "recebido" ? <CheckCircle2 className="w-4 h-4 text-(--text-success)" aria-hidden="true" /> : i.estado !== "enviando" && (
                            <button type="button" aria-label={`Tirar ${i.file.name} da lista`} onClick={() => setItens((xs) => xs.filter((x) => x.id !== i.id))}
                              className="p-1.5 pointer-coarse:p-3 rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><X className="w-4 h-4" aria-hidden="true" /></button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button type="submit" className="w-full" loading={enviando}
                    disabled={naFila === 0 || !nome.trim() || (info.requires_password && !senha)}>
                    {info.requires_password && <Lock className="w-4 h-4" aria-hidden="true" />}
                    {naFila > 0 ? `Enviar ${naFila} ${naFila === 1 ? "arquivo" : "arquivos"}` : "Enviar"}
                  </Button>
                  <p className="text-mac-caption text-(--text-secondary) text-center">Os arquivos vão direto para {info.company_name}. Ninguém além de quem tem acesso à pasta vê o que você mandar.</p>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
