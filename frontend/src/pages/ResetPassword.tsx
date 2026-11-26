import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Eye, EyeOff } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import Button from "@/components/ui/Button";
import { MfaCodeForm } from "@/components/shared/MfaSetup";

/** Lê o que o link do e-mail de recuperação traz depois do # (fluxo do Supabase Auth). */
function readRecoveryHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return {
    token: params.get("access_token"),
    type: params.get("type"),
    error: params.get("error_description") ?? params.get("error"),
  };
}

/** /redefinir-senha — destino do link de "Esqueci a senha" (achado A1-04). */
export default function ResetPassword() {
  usePageTitle("Criar senha nova");
  const { token: tokenDoLink, type, error: linkError } = useMemo(readRecoveryHash, []);
  // Conta com verificação em duas etapas: o código do app troca o token do link por um verificado.
  const [token, setToken] = useState(tokenDoLink);
  const [pedirCodigo, setPedirCodigo] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = token && type === "recovery";

  async function gravar(tok: string | null) {
    setLoading(true);
    setError("");
    try {
      await api.post("/auth/reset-password", { access_token: tok, new_password: password });
      window.history.replaceState(null, "", "/redefinir-senha");  // tira o token da barra de endereço
      setPedirCodigo(false);
      setDone(true);
    } catch (err: any) {
      if (err?.response?.data?.code === "mfa_verificar") setPedirCodigo(true);
      else setError(err?.response?.data?.detail ?? "Não foi possível gravar a senha nova. Tente de novo.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError("A senha precisa ter pelo menos 8 caracteres."); return; }
    if (password !== confirm) { setError("As duas senhas não são iguais."); return; }
    await gravar(token);
  }

  const fieldClass =
    "w-full h-11 sm:h-10 rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) pl-3 pr-11 text-mac-callout sm:text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) focus:border-transparent";

  return (
    <main className="flex min-h-screen items-center justify-center px-5" style={{ background: "var(--wallpaper)" }}>
      <div className="login-enter glass-panel glass-blur-panel glass-shadow rounded-(--radius-dialog) w-full max-w-[420px] px-6 py-7 sm:p-8">
        <div className="brand-wordmark mb-6 block h-[30px] w-[104px]" role="img" aria-label="Docke" />
        {pedirCodigo && !done ? (
          <div className="flex flex-col gap-3">
            <h1 className="text-mac-title2 font-bold text-(--text-primary)">Código do app autenticador</h1>
            <p className="text-mac-body leading-[19px] text-(--text-secondary)">Esta conta usa verificação em duas etapas. Digite o código para gravar a senha nova.</p>
            <MfaCodeForm token={token ?? undefined} submitLabel="Gravar a senha nova"
              onDone={(t) => { setToken(t.access_token); gravar(t.access_token); }} />
          </div>
        ) : done ? (
          <div role="status" className="reveal flex flex-col gap-3">
            <CheckCircle2 className="w-7 h-7 text-(--text-success)" aria-hidden />
            <h1 className="text-mac-title2 font-bold text-(--text-primary)">Senha nova criada.</h1>
            <p className="text-mac-body leading-[19px] text-(--text-secondary)">Entre com o seu e-mail e a senha nova.</p>
            <Link to="/login" className="mt-2 inline-flex h-11 sm:h-10 items-center justify-center rounded-full bg-teal-600 px-5 text-[14px] font-semibold text-white hover:bg-teal-700 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) focus-visible:ring-offset-1">
              Ir para o acesso
            </Link>
          </div>
        ) : !valid ? (
          <div role="alert" className="flex flex-col gap-3">
            <h1 className="text-mac-title2 font-bold text-(--text-primary)">Este link não vale mais.</h1>
            <p className="text-mac-body leading-[19px] text-(--text-secondary)">
              {linkError ? "O link venceu ou já foi usado. " : "Abra esta página pelo link do e-mail de recuperação. "}
              Peça um novo na tela de acesso, em "Esqueci a senha".
            </p>
            <Link to="/login" className="mt-2 inline-flex h-11 sm:h-10 items-center justify-center rounded-full border border-(--border-control) px-5 text-[14px] font-medium text-(--text-primary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
              Ir para o acesso
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
            <h1 className="text-mac-title2 font-bold text-(--text-primary)">Criar uma senha nova</h1>
            <p className="text-mac-body leading-[19px] text-(--text-secondary)">Use pelo menos 8 caracteres. Uma frase curta é mais fácil de lembrar e difícil de adivinhar.</p>
            <div className="flex flex-col gap-1">
              <label htmlFor="rs-senha" className="text-mac-body font-medium text-(--text-secondary)">Senha nova</label>
              <div className="relative">
                <input id="rs-senha" type={show ? "text" : "password"} autoComplete="new-password" autoFocus value={password}
                  onChange={(e) => setPassword(e.target.value)} aria-invalid={tooShort || undefined}
                  aria-describedby="rs-dica" className={fieldClass} />
                <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Ocultar senha" : "Mostrar senha"} aria-pressed={show}
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-(--radius-control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover)">
                  {show ? <EyeOff className="w-4 h-4" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
                </button>
              </div>
              <p id="rs-dica" className={`text-mac-caption ${tooShort ? "text-(--text-danger)" : "text-(--text-secondary)"}`}>
                {password.length}/8 caracteres no mínimo
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="rs-confirma" className="text-mac-body font-medium text-(--text-secondary)">Repita a senha nova</label>
              <input id="rs-confirma" type={show ? "text" : "password"} autoComplete="new-password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? "rs-diferente" : undefined} className={fieldClass.replace("pr-11", "pr-3")} />
              {mismatch && <p id="rs-diferente" className="text-mac-caption text-(--text-danger)">As duas senhas ainda não são iguais.</p>}
            </div>
            {error && <div role="alert" className="reveal rounded-(--radius-control) border border-red-500/30 bg-(--tint-danger) px-3 py-2.5 text-mac-body text-(--text-primary)">{error}</div>}
            <Button type="submit" loading={loading} className="w-full h-11! sm:h-10! text-[14px]! font-semibold mt-1">Gravar senha nova</Button>
          </form>
        )}
      </div>
    </main>
  );
}
