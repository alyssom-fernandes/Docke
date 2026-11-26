import { useEffect, useRef, useState } from "react";
import { Copy, ShieldCheck, Smartphone } from "lucide-react";
import api from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { SessionTokens } from "@/lib/session";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

/**
 * Verificação em duas etapas (decisão do dono, 26/11/2026): cadastro do app
 * autenticador (QR code ou chave digitada) e conferência do código de 6
 * números. Usado na tela de entrada (MfaGate), em Ajustes → Segurança e na
 * recuperação de senha.
 */

/** Campo do código: só números, até 6, com o teclado numérico no celular. */
export function CodeInput({ value, onChange, autoFocus, error }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; error?: string }) {
  return (
    <Input
      label="Código de 6 números"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={7}
      placeholder="000000"
      className="font-mono tracking-[0.3em] text-center text-lg"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      autoFocus={autoFocus}
      error={error}
    />
  );
}

/** Confere o código. `token` serve para a recuperação de senha (sessão do link). */
export async function verifyCode(code: string, opts: { factorId?: string; token?: string } = {}): Promise<SessionTokens> {
  const r = await api.post("/auth/mfa/verify", { code, factor_id: opts.factorId ?? null },
    opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined);
  return r.data as SessionTokens;
}

export function MfaCodeForm({ onDone, token, submitLabel = "Continuar" }: { onDone: (t: SessionTokens) => void; token?: string; submitLabel?: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");

  async function enviar(c = code) {
    if (c.length !== 6 || busy) return;
    setBusy(true);
    setErro("");
    try {
      onDone(await verifyCode(c, { token }));
    } catch (e: any) {
      setErro(friendlyError(e, "Código incorreto. Use o que aparece agora no app."));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); enviar(); }}>
      <p className="flex items-start gap-2 text-mac-body text-(--text-secondary)">
        <Smartphone className="w-4 h-4 mt-0.5 shrink-0 text-(--text-accent)" aria-hidden="true" />
        Abra o app autenticador no celular e digite o código do Docke.
      </p>
      <CodeInput value={code} autoFocus error={erro || undefined}
        onChange={(v) => { setCode(v); if (v.length === 6) enviar(v); }} />
      <Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>{submitLabel}</Button>
    </form>
  );
}

type Cadastro = { factor_id: string; qr_code: string; secret: string; uri: string };

export function MfaEnroll({ onDone }: { onDone: (t: SessionTokens) => void }) {
  const [cad, setCad] = useState<Cadastro | null>(null);
  const [erroInicio, setErroInicio] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");
  const [copiado, setCopiado] = useState(false);
  const iniciou = useRef(false);

  function iniciar() {
    setErroInicio("");
    api.post<Cadastro>("/auth/mfa/enroll").then((r) => setCad(r.data))
      .catch((e) => setErroInicio(friendlyError(e, "Não foi possível começar agora. Tente de novo.")));
  }
  useEffect(() => {
    if (iniciou.current) return;
    iniciou.current = true;
    iniciar();
  }, []);

  async function confirmar(c = code) {
    if (!cad || c.length !== 6 || busy) return;
    setBusy(true);
    setErro("");
    try {
      onDone(await verifyCode(c, { factorId: cad.factor_id }));
    } catch (e: any) {
      setErro(friendlyError(e, "Código incorreto. Use o que aparece agora no app."));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  if (erroInicio) {
    return (
      <div role="alert" className="space-y-3">
        <p className="text-mac-body text-(--text-danger)">{erroInicio}</p>
        <Button variant="secondary" onClick={iniciar}>Tentar de novo</Button>
      </div>
    );
  }
  if (!cad) return <div className="h-48 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" aria-label="Preparando o cadastro" />;

  const chave = cad.secret.replace(/(.{4})/g, "$1 ").trim();
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); confirmar(); }}>
      <ol className="space-y-1.5 text-mac-body text-(--text-secondary) list-decimal pl-5">
        <li>Instale um app autenticador no celular (Google Authenticator, Microsoft Authenticator ou outro).</li>
        <li>No app, toque em adicionar e aponte a câmera para o código abaixo.</li>
        <li>Digite o código de 6 números que o app mostrar.</li>
      </ol>
      <div className="flex flex-col @sm:flex-row items-center gap-4">
        <img src={cad.qr_code} alt="QR code para cadastrar o Docke no app autenticador" width={176} height={176}
          className="w-44 h-44 rounded-(--radius-control) bg-white p-2 shrink-0" />
        <div className="space-y-1.5 min-w-0">
          <p className="text-mac-caption text-(--text-secondary)">Sem câmera? Digite esta chave no app:</p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-mac-body text-(--text-primary) break-all select-all">{chave}</code>
            <button type="button" aria-label="Copiar a chave"
              onClick={() => { navigator.clipboard?.writeText(cad.secret).then(() => { setCopiado(true); window.setTimeout(() => setCopiado(false), 1500); }).catch(() => {}); }}
              className="p-1.5 rounded-(--radius-control) text-(--text-secondary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
              <Copy className="w-4 h-4" aria-hidden="true" />
            </button>
            <span aria-live="polite" className="text-mac-caption text-(--text-success)">{copiado ? "Copiada" : ""}</span>
          </div>
        </div>
      </div>
      <CodeInput value={code} error={erro || undefined} onChange={(v) => { setCode(v); if (v.length === 6) confirmar(v); }} />
      <Button type="submit" className="w-full" loading={busy} disabled={code.length !== 6}>
        <ShieldCheck className="w-4 h-4" aria-hidden="true" /> Ativar
      </Button>
      <p className="text-mac-caption text-(--text-secondary)">Perdeu ou trocou o celular? O administrador geral zera a verificação da sua conta e você cadastra de novo.</p>
    </form>
  );
}
