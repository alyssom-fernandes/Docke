import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ShieldAlert, Search as SearchIcon, Download, FolderLock, FileText } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { usePageTitle } from "@/hooks/usePageTitle";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import SharePolicyCard from "@/components/shared/SharePolicyCard";

interface SensFolder { id: string; name: string; sensitivity: "pessoal" | "sensivel"; documentos: number }
interface Hit { id: string; name: string; folder_id?: string; folder_path_label?: string; sensitivity?: string; snippet?: string }

const LABEL: Record<string, string> = { pessoal: "Dado pessoal", sensivel: "Dado sensível" };

/**
 * Privacidade (LGPD) — X2-17, B3.7.1, B3.7.3: pastas classificadas (dado
 * pessoal ou sensível; sensível bloqueia link público) e o atendimento ao
 * titular: achar tudo que cita um CPF ou nome, exportar a lista e baixar os
 * arquivos. A consulta fica na trilha sem o CPF em claro.
 */
export default function Privacy() {
  usePageTitle("Privacidade (LGPD)");
  const { current } = useCompany();
  const { error: showError } = useToast();
  const [folders, setFolders] = useState<SensFolder[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<{ total: number; results: Hit[] } | null>(null);

  useEffect(() => {
    if (!current) return;
    api.get<SensFolder[]>(`/companies/${current.id}/privacy/folders`).then((r) => setFolders(r.data)).catch(() => setFolders([]));
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function buscar(e: FormEvent) {
    e.preventDefault();
    if (!current || q.trim().length < 3) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${current.id}/privacy/titular`, { params: { q: q.trim() } });
      setHits(r.data);
    } catch (err: any) {
      showError(err?.response?.data?.detail ?? "Não foi possível consultar agora.");
    } finally {
      setBusy(false);
    }
  }

  function exportarCsv() {
    if (!hits) return;
    const linhas = [["Documento", "Pasta", "Classificação"], ...hits.results.map((h) => [h.name, h.folder_path_label ?? "", LABEL[h.sensitivity ?? ""] ?? "Sem classificação"])];
    const csv = "﻿" + linhas.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `pedido-do-titular_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function baixarTodos() {
    if (!hits?.results.length) return;
    try {
      const r = await api.post("/documents/bulk-download", { document_ids: hits.results.map((h) => h.id) }, { responseType: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(r.data);
      a.download = "pedido-do-titular.zip";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      showError("Não foi possível montar o ZIP agora. Tente de novo em alguns instantes ou baixe a lista em CSV.");
    }
  }

  return (
    <div className="space-y-6">
      <section className="glass-panel rounded-(--radius-panel) p-5 space-y-3" aria-labelledby="lgpd-pastas">
        <h3 id="lgpd-pastas" className="flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><FolderLock className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> Pastas com dado pessoal ou sensível</h3>
        <p className="text-mac-caption text-(--text-secondary)">
          Classifique pelo menu da pasta em Documentos (“Privacidade (LGPD)…”). Vale para as subpastas. Pasta com <b>dado sensível</b> (saúde, como ASO e exames; biometria) não aceita link público.
        </p>
        {folders === null ? (
          <div className="h-10 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />
        ) : folders.length === 0 ? (
          <p className="text-mac-body text-(--text-secondary)">Nenhuma pasta classificada ainda. Comece pelas de RH (holerites, ASO, admissões).</p>
        ) : (
          <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
            {folders.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 min-h-11">
                <span className={`rounded-full px-2 py-0.5 text-mac-caption font-medium ${f.sensitivity === "sensivel" ? "bg-red-500/12 text-(--text-danger)" : "bg-amber-500/12 text-(--text-warning)"}`}>{LABEL[f.sensitivity]}</span>
                <Link to={`/documents?folder_id=${f.id}`} className="flex-1 truncate text-mac-body text-(--text-primary) hover:underline">{f.name}</Link>
                <span className="text-mac-caption text-(--text-secondary) tabular-nums">{f.documentos} {f.documentos === 1 ? "documento" : "documentos"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {current && <SharePolicyCard companyId={current.id} canEdit={["admin", "supremo"].includes(current.permission_level)} />}

      <section className="glass-panel rounded-(--radius-panel) p-5 space-y-3" aria-labelledby="lgpd-titular">
        <h3 id="lgpd-titular" className="flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><ShieldAlert className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> Pedido do titular</h3>
        <p className="text-mac-caption text-(--text-secondary)">
          Quando alguém pede acesso, correção ou eliminação dos próprios dados (LGPD, art. 18), procure pelo CPF ou pelo nome. A consulta fica na trilha de auditoria sem o CPF em claro. Documentos com prazo de guarda ou bloqueio judicial não podem ser eliminados antes do fim.
        </p>
        <form onSubmit={buscar} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[14rem]"><Input label="CPF ou nome do titular" value={q} onChange={(e) => setQ(e.target.value)} placeholder="000.000.000-00 ou nome completo" /></div>
          <Button type="submit" loading={busy} disabled={q.trim().length < 3}><SearchIcon className="w-3.5 h-3.5" aria-hidden="true" /> Procurar</Button>
        </form>
        {hits && (
          <div className="reveal space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="flex-1 text-mac-body text-(--text-primary)">{hits.total === 0 ? "Nada encontrado com esse termo." : `${hits.total} ${hits.total === 1 ? "documento cita" : "documentos citam"} o titular${hits.total > hits.results.length ? ` (mostrando ${hits.results.length})` : ""}.`}</p>
              {hits.results.length > 0 && (
                <>
                  <Button size="sm" variant="secondary" onClick={exportarCsv}><Download className="w-3.5 h-3.5" aria-hidden="true" /> Lista (CSV)</Button>
                  <Button size="sm" variant="secondary" onClick={baixarTodos}><Download className="w-3.5 h-3.5" aria-hidden="true" /> Arquivos (ZIP)</Button>
                </>
              )}
            </div>
            <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
              {hits.results.map((h) => (
                <li key={h.id} className="flex items-center gap-3 px-3 min-h-11">
                  <FileText className="w-4 h-4 text-(--text-secondary) shrink-0" aria-hidden="true" />
                  <Link to={`/documents?folder_id=${h.folder_id ?? ""}&doc=${h.id}`} className="flex-1 min-w-0">
                    <span className="block truncate text-mac-body text-(--text-primary) hover:underline">{h.name}</span>
                    {h.folder_path_label && <span className="block truncate text-mac-caption text-(--text-secondary)">{h.folder_path_label}</span>}
                  </Link>
                  {h.sensitivity && h.sensitivity !== "normal" && <span className="shrink-0 text-mac-caption text-(--text-secondary)">{LABEL[h.sensitivity]}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
