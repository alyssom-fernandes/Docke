import { entrarComPasskey, passkeySuportada } from "@/lib/passkey";
import { Fingerprint } from "lucide-react";
import { useState, useEffect, useRef, FormEvent, CSSProperties, KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Eye, EyeOff, ArrowLeft, MailCheck } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import api, { prewarmApi } from "@/lib/api";
import { rememberChoice } from "@/lib/session";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";

const REPO_URL = "https://github.com/alyssom-fernandes/Docke";

// "demo" (padrão, a vitrine pública) mostra primeiro a demonstração;
// "empresa" (deploy de uso real) mostra só o acesso com conta — achado A1-03.
const LOGIN_MODE = (import.meta.env.VITE_LOGIN_MODE ?? "demo") as "demo" | "empresa";

// Depois deste tempo sem resposta, avisa que o servidor está ligando — a API
// na Fly desliga quando ociosa e a primeira requisição espera a máquina subir.
const SLOW_HINT_MS = 5_000;

// Exemplo com nomes e arquivos que existem no seed da demo. A cadeia é por
// empresa e cada "anterior" repete o hash de cima (prev_hash → hash).
const CHAIN_EXAMPLE = [
  { what: "Operador Demo enviou", file: "NF-e_Fornecedor_3.xml", where: "pasta Fiscal, 09:12", prev: "0c4e…19aa", hash: "7a3f…c2d1" },
  { what: "Visualizadora Demo abriu", file: "Holerite_2.pdf", where: "pasta RH, 10:47", prev: "7a3f…c2d1", hash: "e91b…04f7" },
  { what: "Operador Demo moveu", file: "Extrato_Banco_1.pdf", where: "para Bancário, 11:05", prev: "e91b…04f7", hash: "3d08…b6e5" },
  { what: "Visualizadora Demo ancorou", file: "Procuração_1.pdf", where: "pasta Contratos, 11:30", prev: "3d08…b6e5", hash: "5fc2…a918" },
];

type DemoState = "idle" | "loading" | "slow" | "error";
type View = "login" | "forgot" | "forgot-sent";

/** Destino depois de entrar: o endereço pedido antes do login, se for do próprio app. */
function useReturnTo(): string {
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string; search?: string; hash?: string } } | null)?.from;
  if (!from?.pathname || !from.pathname.startsWith("/") || from.pathname.startsWith("//") || from.pathname === "/login") {
    return "/dashboard";
  }
  return `${from.pathname}${from.search ?? ""}${from.hash ?? ""}`;
}

export default function Login() {
  usePageTitle("Entrar");
  const { login, loginDemo, user, loginWithSession } = useAuthContext();
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  async function entrarPasskey() {
    setFormError("");
    setPasskeyBusy(true);
    try {
      await loginWithSession(await entrarComPasskey(), remember);
      navigate(returnTo, { replace: true });
    } catch (err: any) {
      if (err?.name === "NotAllowedError" || err?.message === "cancelado") return;  // a pessoa cancelou no aparelho
      setFormError(err?.response?.data?.detail ?? "Não foi possível entrar com a passkey. Tente de novo ou use a senha.");
    } finally {
      setPasskeyBusy(false);
    }
  }
  const navigate = useNavigate();
  const returnTo = useReturnTo();

  // Vindo de "Esqueci a senha" na sessão expirada (A1-29), abre direto na recuperação.
  const [view, setView] = useState<View>(() => (window.history.state?.usr?.forgot ? "forgot" : "login"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [remember, setRemember] = useState(rememberChoice);
  const [loading, setLoading] = useState(false);
  const [demo, setDemo] = useState<DemoState>("idle");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState("");
  const slowTimer = useRef<number | undefined>(undefined);
  const formErrorRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) navigate(returnTo, { replace: true });
  }, [user, navigate, returnTo]);

  // Acorda a API enquanto o visitante lê a tela.
  useEffect(() => {
    prewarmApi();
    return () => window.clearTimeout(slowTimer.current);
  }, []);

  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);

  function trackCaps(e: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!email.trim()) errs.email = "Informe o e-mail.";
    else if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) errs.email = "Confira o e-mail: falta o @ ou o domínio.";
    if (!password) errs.password = "Informe a senha.";
    setErrors(errs);
    setFormError("");
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      await login(email.trim(), password, remember);
      navigate(returnTo, { replace: true });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) {
        setFormError("E-mail ou senha incorretos. Confira e tente de novo, ou use \"Esqueci a senha\".");
      } else if (err?.response?.data?.detail) {
        setFormError(err.response.data.detail);
      } else {
        setFormError("Não foi possível falar com o servidor. Confira a internet e tente de novo em instantes.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) {
      setErrors({ email: "Informe o e-mail da sua conta." });
      return;
    }
    setErrors({});
    setFormError("");
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", {
        email: email.trim(),
        redirect_to: `${window.location.origin}/redefinir-senha`,
      });
      setView("forgot-sent");
    } catch (err: any) {
      setFormError(err?.response?.data?.detail ?? "Não foi possível pedir o link agora. Tente de novo em instantes.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoLogin() {
    setDemo("loading");
    window.clearTimeout(slowTimer.current);
    slowTimer.current = window.setTimeout(() => setDemo((s) => (s === "loading" ? "slow" : s)), SLOW_HINT_MS);
    try {
      await loginDemo();
      window.clearTimeout(slowTimer.current);
      navigate(returnTo, { replace: true });
    } catch (err: any) {
      window.clearTimeout(slowTimer.current);
      const detail = err?.response?.data?.detail;
      if (detail) {
        setFormError(detail);
        setDemo("idle");
      } else {
        setDemo("error");
      }
    }
  }

  const demoBusy = demo === "loading" || demo === "slow";
  const fieldClass = "h-11! sm:h-10! shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]";

  const formErrorBox = formError && (
    <div
      ref={formErrorRef}
      tabIndex={-1}
      role="alert"
      className="login-reveal rounded-(--radius-control) border border-red-500/30 bg-(--tint-danger) px-3 py-2.5 text-mac-body leading-[19px] text-(--text-primary) focus:outline-hidden"
    >
      {formError}
    </div>
  );

  const accountForm = view === "login" ? (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-left" noValidate aria-describedby={formError ? "login-erro" : undefined}>
      <Input
        ref={emailRef}
        label="E-mail"
        type="email"
        inputMode="email"
        placeholder="voce@empresa.com.br"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
        autoComplete="username"
        disabled={loading}
        className={fieldClass}
      />
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <label htmlFor="login-senha" className="text-mac-body font-medium text-(--text-secondary)">Senha</label>
          <button
            type="button"
            onClick={() => { setView("forgot"); setFormError(""); setErrors({}); }}
            className="text-mac-body text-(--text-accent) underline-offset-[3px] hover:underline dark:text-teal-200 min-h-6 pointer-coarse:min-h-11 px-0.5 rounded-sm"
          >
            Esqueci a senha
          </button>
        </div>
        <div className="relative">
          <input
            id="login-senha"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyUp={trackCaps}
            onKeyDown={trackCaps}
            onBlur={() => setCapsLock(false)}
            autoComplete="current-password"
            disabled={loading}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={[errors.password ? "login-senha-erro" : "", capsLock ? "login-caps" : ""].filter(Boolean).join(" ") || undefined}
            className={`w-full h-11 sm:h-10 rounded-(--radius-control) border pl-3 pr-11 text-mac-callout sm:text-mac-body bg-(--bg-card) text-(--text-primary)
              border-(--border-control) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) focus:border-transparent transition-all duration-fast
              shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]
              ${errors.password ? "border-red-500" : ""}`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
            aria-pressed={showPassword}
            className="absolute right-0.5 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-(--radius-control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover)"
          >
            {showPassword ? <EyeOff className="w-4 h-4" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
          </button>
        </div>
        {errors.password && <p id="login-senha-erro" className="text-mac-caption text-(--text-danger)">{errors.password}</p>}
        {capsLock && <p id="login-caps" className="text-mac-caption text-(--text-warning)">A tecla Caps Lock está ativada.</p>}
      </div>
      <label className="flex items-center gap-2.5 min-h-8 pointer-coarse:min-h-11 cursor-pointer select-none text-mac-body text-(--text-secondary)">
        <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Manter conectado neste computador
      </label>
      <div id="login-erro">{formErrorBox}</div>
      <Button
        type="submit"
        variant={LOGIN_MODE === "empresa" ? "primary" : "secondary"}
        loading={loading}
        disabled={demoBusy}
        className="w-full h-11! sm:h-10! text-[14px]! font-semibold"
      >
        Entrar
      </Button>
      {passkeySuportada() && (
        <Button type="button" variant="ghost" loading={passkeyBusy} disabled={loading || demoBusy} onClick={entrarPasskey}
          className="w-full h-11! sm:h-10! text-[14px]!">
          <Fingerprint className="w-4 h-4" aria-hidden /> Entrar com digital ou rosto
        </Button>
      )}
    </form>
  ) : view === "forgot" ? (
    <form onSubmit={handleForgot} className="flex flex-col gap-3 text-left login-reveal" noValidate>
      <button
        type="button"
        onClick={() => { setView("login"); setFormError(""); setErrors({}); }}
        className="self-start inline-flex items-center gap-1 text-mac-body text-(--text-secondary) hover:text-(--text-primary) min-h-8 pointer-coarse:min-h-11 rounded-sm"
      >
        <ArrowLeft className="w-3.5 h-3.5" aria-hidden /> Voltar para o acesso
      </button>
      <p className="text-mac-body leading-[19px] text-(--text-secondary)">
        Informe o e-mail da sua conta. Enviamos um link para você criar uma senha nova; ele vale por 1 hora.
      </p>
      <Input
        label="E-mail"
        type="email"
        inputMode="email"
        placeholder="voce@empresa.com.br"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
        autoComplete="username"
        autoFocus
        disabled={loading}
        className={fieldClass}
      />
      {formErrorBox}
      <Button type="submit" loading={loading} className="w-full h-11! sm:h-10! text-[14px]! font-semibold">
        Enviar link
      </Button>
    </form>
  ) : (
    <div className="flex flex-col gap-3 text-left login-reveal" role="status">
      <MailCheck className="w-6 h-6 text-(--text-accent)" aria-hidden />
      <p className="text-mac-callout font-semibold text-(--text-primary)">Confira seu e-mail</p>
      <p className="text-mac-body leading-[19px] text-(--text-secondary)">
        Se <strong className="text-(--text-primary) font-medium">{email.trim()}</strong> tiver cadastro, chega em alguns minutos um link para criar a senha nova. Confira também a caixa de spam. Se não chegar, fale com o administrador da sua empresa.
      </p>
      <Button variant="secondary" onClick={() => setView("login")} className="w-full h-11! sm:h-10!">Voltar para o acesso</Button>
    </div>
  );

  return (
    <div className="relative min-h-screen overflow-hidden" style={{ background: "var(--wallpaper)" }}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-80 dark:opacity-100"
        style={{
          background:
            "radial-gradient(680px circle at 16% 12%, rgba(13,148,136,0.20), transparent 55%)," +
            "radial-gradient(620px circle at 84% 82%, rgba(20,184,166,0.16), transparent 55%)," +
            "radial-gradient(900px circle at 50% 118%, rgba(13,148,136,0.12), transparent 60%)",
        }}
      />

      <a href="#acesso-titulo" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-10 text-mac-body text-(--text-accent) dark:text-teal-200">
        Pular para o acesso
      </a>

      <main
        className="relative mx-auto grid min-h-screen max-w-[1280px] grid-cols-1 content-start gap-10 px-5 pb-7 pt-8 sm:px-8 sm:pt-10
          lg:grid-cols-[minmax(0,3fr)_minmax(380px,2fr)] lg:grid-rows-[auto_1fr_auto] lg:content-center lg:gap-x-20 lg:gap-y-11 lg:px-14 lg:pt-14 lg:pb-8
          2xl:max-w-[1440px] 2xl:gap-x-28"
      >
        {/* Apresentação */}
        <section aria-labelledby="titulo" className="login-enter lg:col-start-1 lg:row-start-1">
          <div className="brand-wordmark block w-[124px] h-[36px]" role="img" aria-label="Docke" />
          <h1
            id="titulo"
            className="mt-8 max-w-[22ch] text-[30px] leading-[36px] font-bold tracking-[-0.022em] text-(--text-primary) sm:text-[34px] sm:leading-[40px] lg:mt-12 lg:text-[42px] lg:leading-[48px] 2xl:text-[48px] 2xl:leading-[54px] display-type"
            style={{ textWrap: "balance" } as CSSProperties}
          >
            Os documentos das suas empresas, achados em segundos.
          </h1>
          <p className="mt-4 max-w-[52ch] text-[15px] leading-[23px] text-(--text-secondary) lg:text-[16px] lg:leading-[25px]">
            Notas fiscais, folha e contratos pesquisáveis até no texto digitalizado, prazos de obrigações que avisam antes
            de vencer e um registro de tudo o que aconteceu com cada documento, que prova que nada foi alterado.
          </p>
        </section>

        {/* Acesso */}
        <section aria-labelledby="acesso-titulo" className="login-enter login-enter-2 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">
          <div className="glass-panel glass-blur-panel glass-shadow rounded-(--radius-dialog) px-5 py-6 sm:p-8">
            {LOGIN_MODE === "demo" && view === "login" ? (
              <>
                <h2 id="acesso-titulo" tabIndex={-1} className="text-mac-title2 font-bold text-(--text-primary) focus:outline-hidden">Ver o Docke por dentro</h2>
                <p className="mt-1.5 mb-[18px] text-mac-body leading-[19px] text-(--text-secondary)">
                  Abre uma conta de demonstração com 3 empresas fictícias. Sem cadastro e sem senha.
                </p>
                <Button
                  type="button"
                  onClick={handleDemoLogin}
                  loading={demoBusy}
                  disabled={loading}
                  className="w-full h-11! sm:h-10! text-[14px]! font-semibold"
                >
                  {demoBusy ? "Abrindo a demonstração…" : demo === "error" ? "Tentar de novo" : "Explorar a demonstração"}
                </Button>
                <div role="status" aria-live="polite">
                  {demo === "slow" && (
                    <p className="login-reveal mt-3 text-mac-footnote leading-[18px] text-(--text-secondary)">
                      O servidor estava em repouso e está ligando. Leva uns 10 segundos.
                    </p>
                  )}
                </div>
                {demo === "error" && (
                  <div role="alert" className="login-reveal mt-3.5 rounded-(--radius-control) border border-red-500/30 bg-(--tint-danger) px-4 py-3.5">
                    <p className="text-mac-body leading-[19px] text-(--text-secondary)">
                      <strong className="mb-1 block font-semibold text-(--text-primary)">Não foi possível abrir a demonstração agora.</strong>
                      O servidor não respondeu a tempo. Tente de novo em alguns minutos.
                    </p>
                  </div>
                )}
                <div className="mt-6 mb-4 flex items-center gap-3 text-mac-footnote text-(--text-secondary)">
                  <div className="h-px flex-1 bg-(--border-default)" />
                  ou entre com sua conta
                  <div className="h-px flex-1 bg-(--border-default)" />
                </div>
              </>
            ) : (
              <h2 id="acesso-titulo" tabIndex={-1} className="mb-4 text-mac-title2 font-bold text-(--text-primary) focus:outline-hidden">
                {view === "login" ? "Entrar no Docke" : view === "forgot" ? "Criar uma senha nova" : "Link enviado"}
              </h2>
            )}
            {accountForm}
          </div>
        </section>

        {/* Prova de integridade, com dados da demonstração */}
        <section aria-labelledby="trilha" className="login-enter login-enter-3 lg:col-start-1 lg:row-start-2">
          <h2 id="trilha" className="text-mac-footnote font-semibold uppercase tracking-[0.06em] text-(--text-secondary) mb-4">
            Cada ação fica registrada e encadeada
          </h2>
          <ol className="login-chain relative max-w-[600px]">
            {CHAIN_EXAMPLE.map((e, i) => (
              <li
                key={e.hash}
                className={`relative grid grid-cols-1 pb-[18px] pl-[30px] sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-x-5 ${i === 3 ? "hidden sm:grid" : ""}`}
              >
                <span className="text-[14px] leading-5 text-(--text-primary)">
                  {e.what} <span className="whitespace-nowrap font-medium">{e.file}</span>
                </span>
                <span className="mt-0.5 text-mac-footnote leading-[17px] text-(--text-secondary) sm:col-start-1">
                  Comércio Alfa Modelo Ltda, {e.where}
                </span>
                <span className="mt-1 whitespace-nowrap font-mono text-[11.5px] leading-[17px] text-(--text-secondary) sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:text-right">
                  anterior <span className={i === 0 ? "" : "text-(--text-accent) dark:text-teal-200"}>{e.prev}</span>
                  <br />
                  <span className="text-(--text-accent) dark:text-teal-200">registro {e.hash}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-1 max-w-[56ch] text-[12.5px] leading-[19px] text-(--text-secondary)">
            Exemplo com dados fictícios. Cada registro carrega o código do anterior: se alguém alterar ou apagar um
            registro, a verificação mostra exatamente onde.
          </p>
        </section>

        <footer className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-mac-footnote text-(--text-secondary) lg:col-span-2 lg:row-start-3">
          {LOGIN_MODE === "demo" ? (
            <>
              <span>
                Desenvolvido por{" "}
                <span className="font-bold" style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--afn-brand)" }}>
                  AFN Systems
                </span>
              </span>
              <a href={REPO_URL} className="text-(--text-accent) underline underline-offset-[3px] hover:text-(--text-accent) dark:text-teal-200 dark:hover:text-teal-100">
                Código-fonte no GitHub
              </a>
            </>
          ) : (
            <span>Docke · gestão de documentos do Grupo Zen</span>
          )}
        </footer>
      </main>
    </div>
  );
}
