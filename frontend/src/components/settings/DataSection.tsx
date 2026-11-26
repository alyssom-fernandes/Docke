import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Download, FileSearch, RotateCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import api from "@/lib/api";
import { relativeDate } from "@/lib/date";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";

interface TextStatus {
  com_texto: number;
  na_fila: number;
  a_reler: number;
}

interface ExportPart {
  name: string;
  size_bytes: number;
  documents: number;
  download_url?: string;
}

interface CompanyExport {
  id: string;
  status: "pending" | "processing" | "done" | "failed";
  parts: ExportPart[];
  document_count: number | null;
  total_bytes: number | null;
  hash_mismatches: number | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
  requested_by_name: string | null;
}

function formatBytes(n: number | null | undefined): string {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2).replace(".", ",")} GB`;
}

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;

/**
 * Ajustes → Organização: o texto dos documentos (OCR) e a exportação completa
 * da empresa atual. Só aparece para o admin da empresa.
 */
export default function DataSection({ companyId, companyName }: { companyId: string; companyName: string }) {
  const { success, error: showError } = useToast();
  const [text, setText] = useState<TextStatus | null>(null);
  const [exports, setExports] = useState<CompanyExport[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, e] = await Promise.all([
        api.get<TextStatus>("/documents/text-status", { params: { company_id: companyId } }),
        api.get<CompanyExport[]>(`/companies/${companyId}/exports`),
      ]);
      setText(t.data);
      setExports(e.data);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [companyId]);

  useEffect(() => {
    setText(null);
    setExports(null);
    load();
  }, [load]);

  // Enquanto houver texto na fila ou exportação em andamento, atualiza a cada 5 s.
  const running = (text?.na_fila ?? 0) > 0 || (exports ?? []).some((e) => e.status === "pending" || e.status === "processing");
  useEffect(() => {
    if (!running) return;
    timer.current = window.setInterval(load, 5000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [running, load]);

  async function reread() {
    setRereading(true);
    try {
      const r = await api.post<{ enqueued: number }>("/documents/reprocess-text", { company_id: companyId });
      success(r.data.enqueued ? `${plural(r.data.enqueued, "documento voltou", "documentos voltaram")} para a leitura de texto.` : "Nenhum documento precisava ser relido.");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível pôr os documentos na fila. Tente de novo.");
    } finally {
      setRereading(false);
    }
  }

  async function requestExport() {
    setRequesting(true);
    try {
      await api.post(`/companies/${companyId}/exports`);
      success("Exportação iniciada. Você pode sair desta tela: os arquivos ficam aqui quando estiverem prontos.");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível iniciar a exportação. Tente de novo.");
    } finally {
      setRequesting(false);
    }
  }

  if (loadError && !text) {
    return (
      <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 flex items-center gap-3">
        <AlertTriangle className="w-4 h-4 text-(--text-warning) shrink-0" aria-hidden />
        <p className="flex-1 text-mac-body text-(--text-secondary)">Não foi possível carregar a situação dos dados desta empresa.</p>
        <Button size="sm" variant="secondary" onClick={load}>Tentar de novo</Button>
      </div>
    );
  }

  const busyExport = (exports ?? []).find((e) => e.status === "pending" || e.status === "processing");

  return (
    <section aria-labelledby="dados-titulo" className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-5 space-y-5">
      <div className="flex items-center gap-2">
        <Archive className="w-4 h-4 text-(--text-accent) shrink-0" aria-hidden />
        <h2 id="dados-titulo" className="text-mac-body font-semibold text-(--text-primary) truncate">
          Dados <span className="text-(--text-tertiary) font-normal">de</span> {companyName}
        </h2>
      </div>

      {/* Texto dos documentos (OCR) */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <FileSearch className="w-5 h-5 text-(--text-tertiary) shrink-0 hidden sm:block" aria-hidden />
        <div className="flex-1 min-w-0" aria-live="polite">
          <p className="text-mac-body font-medium text-(--text-primary)">Texto dos documentos</p>
          {text === null ? (
            <p className="text-mac-caption text-(--text-tertiary)">Carregando…</p>
          ) : (
            <p className="text-mac-caption text-(--text-secondary)">
              {plural(text.com_texto, "documento pesquisável pelo conteúdo", "documentos pesquisáveis pelo conteúdo")}
              {text.na_fila > 0 && ` · ${plural(text.na_fila, "sendo lido agora", "sendo lidos agora")}`}
              {text.a_reler > 0 && ` · ${plural(text.a_reler, "sem texto ou com falha", "sem texto ou com falha")}`}
            </p>
          )}
        </div>
        {text && text.a_reler > 0 && (
          <Button size="sm" variant="secondary" loading={rereading} onClick={reread}>
            <RotateCw className="w-3.5 h-3.5" aria-hidden />
            Ler de novo
          </Button>
        )}
      </div>

      <div className="h-px bg-(--border-default)" />

      {/* Exportação completa */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <Download className="w-5 h-5 text-(--text-tertiary) shrink-0 hidden sm:block" aria-hidden />
          <div className="flex-1 min-w-0">
            <p className="text-mac-body font-medium text-(--text-primary)">Exportar tudo</p>
            <p className="text-mac-caption text-(--text-secondary)">
              Um ZIP com todos os documentos na mesma árvore de pastas, um manifesto com o SHA-256 de cada arquivo e os metadados, e a trilha de auditoria. Os links valem por 7 dias.
            </p>
          </div>
          <Button size="sm" loading={requesting} disabled={!!busyExport} onClick={requestExport}>
            {busyExport ? "Exportando…" : "Exportar"}
          </Button>
        </div>

        {exports && exports.length > 0 && (
          <ul className="rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)" aria-live="polite">
            {exports.slice(0, 5).map((e) => (
              <li key={e.id} className="px-3 py-2.5 text-mac-caption">
                <div className="flex items-center gap-2 flex-wrap">
                  {e.status === "done" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-(--text-success) shrink-0" aria-hidden />
                  ) : e.status === "failed" ? (
                    <AlertTriangle className="w-3.5 h-3.5 text-(--text-warning) shrink-0" aria-hidden />
                  ) : (
                    <RotateCw className="w-3.5 h-3.5 text-(--text-accent) animate-spin motion-reduce:animate-none shrink-0" aria-hidden />
                  )}
                  <span className="text-(--text-primary) font-medium">
                    {e.status === "done"
                      ? `${plural(e.document_count ?? 0, "documento", "documentos")} · ${formatBytes(e.total_bytes)}`
                      : e.status === "failed"
                        ? (e.error_message ?? "A exportação falhou.")
                        : e.status === "processing" ? "Montando os arquivos…" : "Na fila…"}
                  </span>
                  <span className="text-(--text-tertiary)">
                    pedida {relativeDate(e.created_at)}{e.requested_by_name ? ` por ${e.requested_by_name}` : ""}
                  </span>
                </div>
                {e.status === "done" && (e.hash_mismatches ?? 0) > 0 && (
                  <p className="mt-1 text-(--text-warning)">
                    {plural(e.hash_mismatches ?? 0, "arquivo não conferiu", "arquivos não conferiram")} com o hash registrado — veja a coluna "confere" do manifesto.
                  </p>
                )}
                {e.status === "done" && e.parts.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {e.parts.map((p, i) => (
                      <a
                        key={p.name}
                        href={p.download_url}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-(--border-default) text-(--text-primary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-teal-400"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden />
                        {e.parts.length > 1 ? `Parte ${i + 1} de ${e.parts.length}` : "Baixar ZIP"}
                        <span className="text-(--text-tertiary)">{formatBytes(p.size_bytes)}</span>
                      </a>
                    ))}
                    {e.expires_at && <span className="self-center text-(--text-tertiary)">expira {relativeDate(e.expires_at)}</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
