import { useEffect, useState } from "react";
import { Fingerprint, Trash2 } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { cadastrarPasskey, passkeySuportada } from "@/lib/passkey";
import { relativeDate } from "@/lib/date";

/*
 * Passkeys (B4.5.8, B4.2.3): entrar com a digital, o rosto ou uma chave de
 * segurança, sem digitar a senha. A chave fica no aparelho; o Docke guarda
 * só a parte pública. A regra de MFA da empresa continua valendo.
 */

interface Passkey { id: string; name: string; created_at: string; last_used_at: string | null }

export default function PasskeysCard() {
  const { success, error: showError } = useToast();
  const [lista, setLista] = useState<Passkey[] | null>(null);
  const [nome, setNome] = useState("");
  const [busy, setBusy] = useState(false);
  const suportada = passkeySuportada();

  function carregar() { api.get<Passkey[]>("/auth/passkeys").then((r) => setLista(r.data)).catch(() => setLista([])); }
  useEffect(carregar, []);

  async function criar() {
    setBusy(true);
    try {
      await cadastrarPasskey(nome.trim() || "Este aparelho");
      success("Passkey criada. Na próxima vez, use “Entrar com digital ou rosto”.");
      setNome(""); carregar();
    } catch (e: any) {
      if (e?.name === "NotAllowedError" || e?.message === "cancelado") return;
      if (e?.name === "InvalidStateError") { showError("Este aparelho já tem uma passkey do Docke."); return; }
      showError(e?.response?.data?.detail ?? "Não foi possível criar a passkey neste aparelho.");
    } finally { setBusy(false); }
  }
  async function apagar(p: Passkey) {
    try { await api.delete(`/auth/passkeys/${p.id}`); success(`"${p.name}" apagada.`); carregar(); }
    catch { showError("Não foi possível apagar."); }
  }

  return (
    <section className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-6" aria-label="Passkeys">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-[9px] flex items-center justify-center shrink-0 bg-teal-600" aria-hidden="true">
          <Fingerprint className="w-4 h-4 text-white" strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <h2 className="text-mac-body font-semibold text-(--text-primary)">Entrar com digital ou rosto (passkey)</h2>
          <p className="text-mac-caption text-(--text-secondary) mt-0.5">A chave fica guardada no aparelho; o Docke guarda só a parte pública. Se a empresa pede o app autenticador, ele continua sendo pedido.</p>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {lista && lista.length > 0 && (
          <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
            {lista.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                <span className="flex-1 min-w-0">
                  <span className="block text-mac-body text-(--text-primary) truncate">{p.name}</span>
                  <span className="block text-mac-caption text-(--text-secondary)">Criada {relativeDate(p.created_at)}{p.last_used_at ? ` · usada ${relativeDate(p.last_used_at)}` : " · ainda não usada"}</span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => apagar(p)} aria-label={`Apagar a passkey ${p.name}`}><Trash2 className="w-4 h-4" aria-hidden /></Button>
              </li>
            ))}
          </ul>
        )}
        {suportada ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[12rem]"><Input label="Nome deste aparelho (opcional)" value={nome} maxLength={80} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Celular do trabalho" /></div>
            <Button loading={busy} onClick={criar}><Fingerprint className="w-4 h-4" aria-hidden /> Criar passkey neste aparelho</Button>
          </div>
        ) : <p className="text-mac-caption text-(--text-tertiary)">Este navegador não aceita passkey.</p>}
      </div>
    </section>
  );
}
