import { useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldQuestion, Copy } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";

type Resultado = "integro" | "divergente" | "sem_registro" | "arquivo_ausente";
interface Conferencia { resultado: Resultado; sha256_registrado: string | null; sha256_atual: string | null; versao: number | null; conferido_em: string }

export const shortHash = (h: string) => `${h.slice(0, 4)}…${h.slice(-4)}`;

const TEXTO: Record<Resultado, { titulo: string; detalhe: string; tom: string; Icon: typeof ShieldCheck }> = {
  integro: { titulo: "Íntegro", detalhe: "O arquivo guardado é idêntico ao enviado", tom: "text-(--text-success)", Icon: ShieldCheck },
  divergente: { titulo: "Diferente do enviado", detalhe: "O arquivo guardado não bate com a impressão digital registrada no envio. Avise o administrador.", tom: "text-(--text-danger)", Icon: ShieldAlert },
  sem_registro: { titulo: "Sem impressão digital", detalhe: "Esta versão foi enviada antes do registro por versão (26/11/2026); não há com o que comparar.", tom: "text-(--text-secondary)", Icon: ShieldQuestion },
  arquivo_ausente: { titulo: "Arquivo não encontrado", detalhe: "O arquivo desta versão não está no armazenamento. Avise o administrador.", tom: "text-(--text-danger)", Icon: ShieldAlert },
};

/**
 * Selo de integridade no painel do documento (J1-08): a ideia da cadeia de
 * hash do login levada para dentro do app, com substância — o servidor
 * recalcula o SHA-256 do arquivo guardado e compara com o registrado no envio
 * da versão atual; a conferência entra na trilha.
 */
export default function IntegrityCheck({ documentId }: { documentId: string }) {
  const { error: showError, success } = useToast();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Conferencia | null>(null);

  async function conferir() {
    setBusy(true);
    try {
      const r = await api.post<Conferencia>(`/documents/${documentId}/integrity`);
      setRes(r.data);
    } catch (e) {
      showError(friendlyError(e, "Não foi possível conferir agora. Tente de novo."));
    } finally {
      setBusy(false);
    }
  }

  const t = res ? TEXTO[res.resultado] : null;
  return (
    <section aria-labelledby={`integ-${documentId}`} className="rounded-(--radius-control) border border-(--border-default) px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-(--text-accent) shrink-0" aria-hidden="true" />
        <h3 id={`integ-${documentId}`} className="flex-1 text-mac-caption font-semibold text-(--text-primary)">Integridade</h3>
        <button onClick={conferir} disabled={busy} aria-busy={busy || undefined}
          className="text-mac-caption font-medium text-(--text-accent) hover:underline disabled:opacity-60 min-h-6 pointer-coarse:min-h-11">
          {busy ? "Conferindo…" : res ? "Conferir de novo" : "Conferir"}
        </button>
      </div>
      {!res && <p className="mt-1 text-mac-caption text-(--text-secondary)">Compara o arquivo guardado com a impressão digital (SHA-256) registrada no envio.</p>}
      {res && t && (
        <div role="status" className="mt-1.5">
          <p className={`flex items-center gap-1.5 text-mac-caption font-semibold ${t.tom}`}>
            <t.Icon className="w-3.5 h-3.5" aria-hidden="true" /> {t.titulo}{res.versao ? ` · versão ${res.versao}` : ""}
          </p>
          <p className="text-mac-caption text-(--text-secondary)">{t.detalhe}.</p>
          {res.sha256_registrado && (
            <button
              onClick={() => navigator.clipboard?.writeText(res.sha256_registrado!).then(() => success("Impressão digital copiada."))}
              title={res.sha256_registrado}
              aria-label={`Copiar impressão digital SHA-256 ${res.sha256_registrado}`}
              className="mt-1 inline-flex items-center gap-1 font-mono text-mac-caption2 text-(--text-secondary) hover:text-(--text-primary)"
            >
              SHA-256 {shortHash(res.sha256_registrado)} <Copy className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
