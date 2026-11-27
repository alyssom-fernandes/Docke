import { useState, useEffect, useRef, FormEvent, KeyboardEvent, ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Eye, EyeOff, ArrowLeft, MailCheck, Fingerprint, ArrowBigUp, AlertCircle, Sun, Moon } from "lucide-react";
import { entrarComPasskey, passkeySuportada } from "@/lib/passkey";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import api, { prewarmApi } from "@/lib/api";
import { rememberChoice } from "@/lib/session";
import { toggleTheme, useIsDark } from "@/lib/theme";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";
import Tooltip from "@/components/ui/Tooltip";
import Wallpaper from "@/components/layout/Wallpaper";

const REPO_URL = "https://github.com/alyssom-fernandes/Docke";

// "demo" (padrão, a vitrine pública) mostra primeiro a demonstração;
// "empresa" (deploy de uso real) mostra só o acesso com conta — achado A1-03.
const LOGIN_MODE = (import.meta.env.VITE_LOGIN_MODE ?? "demo") as "demo" | "empresa";

// Depois deste tempo sem resposta, avisa que o servidor está ligando — a API
// na Fly desliga quando ociosa e a primeira requisição espera a máquina subir.
const SLOW_HINT_MS = 5_000;

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

/**
 * Entrada do Docke: uma janela pequena de acesso sobre o papel de parede, como
 * a folha de entrar de um app do Mac. Tudo cabe na tela, sem rolagem.
 */
export default function Login() {
  usePageTitle("Entrar");
  const { login, loginDemo, user, loginWithSession } = useAuthContext();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const isDark = useIsDark();

  // Vindo de "Esqueci a senha" na sessão expirada (A1-29), abre direto na recuperação.
  const [view, setView] = useState<View>(() => (window.history.state?.usr?.forgot ? "forgot" : "login"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [remember, setRemember] = useState(rememberChoice);
  const [loading, setLoading] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [demo, setDemo] = useState<DemoState>("idle");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState("");
  const slowTimer = useRef<number | undefined>(undefined);
  const formErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user) navigate(returnTo, { replace: true });
  }, [user, navigate, returnTo]);

  // Acorda a API enquanto o visitante olha a tela.
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

  function goTo(next: View) {
    setView(next);
    setFormError("");
    setErrors({});
  }

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
        setShake(true);  // como no Mac, a senha errada sacode o campo
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
    setFormError("");
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

  const formErrorBox = formError && (
    <div
      ref={formErrorRef}
      tabIndex={-1}
      role="alert"
      className="reveal flex items-start gap-2 rounded-[8px] bg-(--tint-danger) px-3 py-2 text-left text-[12px] leading-4 text-(--text-primary) focus:outline-hidden"
    >
      <AlertCircle className="mt-px size-3.5 shrink-0 text-(--text-danger)" aria-hidden />
      <span>{formError}</span>
    </div>
  );

  const header = (title: string, subtitle?: ReactNode) => (
    <div className="flex flex-col items-center text-center">
      {/* Ícone do app, como na folha de entrar do Mac. */}
      <span aria-hidden className="flex size-12 sm:size-14 items-center justify-center rounded-[12px] sm:rounded-[14px] bg-linear-to-b from-[#17A897] to-[#0A6B61] shadow-[0_1px_2px_rgba(0,0,0,0.2),0_6px_16px_-6px_rgba(10,107,97,0.55),inset_0_1px_0_rgba(255,255,255,0.25)]">
        <span className="brand-mark size-7 sm:size-8 bg-white!" />
      </span>
      <h1 id="acesso-titulo" tabIndex={-1} className="mt-2.5 sm:mt-3 text-[17px] font-semibold leading-[22px] text-(--text-primary) focus:outline-hidden">
        {title}
      </h1>
      {subtitle && <p className="mt-1 text-[13px] leading-[18px] text-(--text-secondary)">{subtitle}</p>}
    </div>
  );

  let content: ReactNode;
  if (view === "login") {
    content = (
      <>
        {LOGIN_MODE === "demo"
          ? header("Conheça o Docke", "Documentos, prazos e trilha de auditoria.")
          : header("Entrar no Docke")}

        {LOGIN_MODE === "demo" && (
          <div className="mt-4 sm:mt-5">
            <Button type="button" onClick={handleDemoLogin} loading={demoBusy} disabled={loading} className="w-full">
              {demoBusy ? "Abrindo a demonstração…" : demo === "error" ? "Tentar de novo" : "Explorar a demonstração"}
            </Button>
            <div role="status" aria-live="polite" className="mt-1.5 text-center text-[12px] leading-4 text-(--text-secondary)">
              {demo === "slow" ? "O servidor estava em repouso e está ligando. Leva uns 10 segundos." : "3 empresas fictícias, sem cadastro."}
            </div>
            {demo === "error" && (
              <p role="alert" className="reveal mt-2 rounded-[8px] bg-(--tint-danger) px-3 py-2 text-center text-[12px] leading-4 text-(--text-primary)">
                Não foi possível abrir a demonstração agora. Tente de novo em alguns minutos.
              </p>
            )}
            <div className="my-3 sm:my-4 flex items-center gap-3 text-[12px] text-(--text-secondary)">
              <span className="h-px flex-1 bg-(--separator)" />
              ou entre com sua conta
              <span className="h-px flex-1 bg-(--separator)" />
            </div>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          noValidate
          className={`flex flex-col gap-3 ${LOGIN_MODE === "demo" ? "" : "mt-5"}`}
          aria-describedby={formError ? "login-erro" : undefined}
        >
          <Input
            label="E-mail"
            type="email"
            inputMode="email"
            placeholder="voce@empresa.com.br"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            disabled={loading}
          />
          <div className={shake ? "lock-shake" : ""} onAnimationEnd={() => setShake(false)}>
            <label htmlFor="login-senha" className="text-[13px] font-medium text-(--text-primary)">Senha</label>
            <div className="relative mt-1">
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
                className={`mac-field h-7 pointer-coarse:h-11 w-full pl-2 ${capsLock ? "pr-14" : "pr-9"} text-[13px] pointer-coarse:text-[16px] text-(--text-primary) disabled:opacity-60 ${errors.password ? "mac-field-error" : ""}`}
              />
              <div className="absolute inset-y-0 right-0.5 flex items-center gap-0.5">
                {capsLock && <ArrowBigUp className="size-3.5 text-(--text-secondary)" aria-hidden />}
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  aria-pressed={showPassword}
                  className="flex size-6 pointer-coarse:size-10 items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--control-fill) hover:text-(--text-primary)"
                >
                  {showPassword ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
                </button>
              </div>
            </div>
            {errors.password && <p id="login-senha-erro" className="mt-1 text-mac-caption text-(--text-danger)">{errors.password}</p>}
            {capsLock && <p id="login-caps" className="mt-1 text-mac-caption text-(--text-warning)">A tecla Caps Lock está ativada.</p>}
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="flex min-h-6 pointer-coarse:min-h-11 cursor-pointer select-none items-center gap-2 text-[13px] text-(--text-primary)">
              <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Manter conectado
            </label>
            <button
              type="button"
              onClick={() => goTo("forgot")}
              className="min-h-6 pointer-coarse:min-h-11 rounded-sm px-0.5 text-[13px] text-(--text-accent) underline-offset-[3px] hover:underline"
            >
              Esqueci a senha
            </button>
          </div>
          {formError && <div id="login-erro">{formErrorBox}</div>}
          {/* Entrar e a digital na mesma linha: a janela cabe inteira até no celular pequeno. */}
          <div className="flex gap-2">
            <Button type="submit" variant={LOGIN_MODE === "empresa" ? "primary" : "secondary"} loading={loading} disabled={demoBusy} className="flex-1">
              Entrar
            </Button>
            {passkeySuportada() && (
              <Tooltip label="Entrar com digital ou rosto">
                <Button type="button" variant="secondary" loading={passkeyBusy} disabled={loading || demoBusy} onClick={entrarPasskey} className="w-8 px-0! pointer-coarse:w-11">
                  <Fingerprint aria-hidden />
                </Button>
              </Tooltip>
            )}
          </div>
        </form>
      </>
    );
  } else if (view === "forgot") {
    content = (
      <>
        {header("Criar uma senha nova", "Enviamos um link que vale por 1 hora.")}
        <form onSubmit={handleForgot} noValidate className="reveal mt-5 flex flex-col gap-3">
          <Input
            label="E-mail da sua conta"
            type="email"
            inputMode="email"
            placeholder="voce@empresa.com.br"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            disabled={loading}
          />
          {formErrorBox}
          <Button type="submit" loading={loading} className="w-full">Enviar link</Button>
          <Button type="button" variant="ghost" onClick={() => goTo("login")} className="w-full">
            <ArrowLeft aria-hidden /> Voltar
          </Button>
        </form>
      </>
    );
  } else {
    content = (
      <>
        <div className="flex flex-col items-center text-center" role="status">
          <span aria-hidden className="flex size-14 items-center justify-center rounded-full bg-(--tint-accent)">
            <MailCheck className="size-7 text-(--text-accent)" />
          </span>
          <h1 id="acesso-titulo" tabIndex={-1} className="mt-3 text-[17px] font-semibold leading-[22px] text-(--text-primary) focus:outline-hidden">
            Confira seu e-mail
          </h1>
          <p className="mt-1.5 text-[13px] leading-[18px] text-(--text-secondary)">
            Se <strong className="font-medium text-(--text-primary)">{email.trim()}</strong> tiver cadastro, o link chega em alguns minutos.
            Veja também o spam.
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={() => goTo("login")} className="mt-5 w-full">Voltar para o acesso</Button>
      </>
    );
  }

  return (
    <div className="wallpaper-screen relative isolate flex min-h-dvh flex-col items-center justify-center overflow-x-hidden px-4 py-6">
      <Wallpaper fixed />

      <a href="#acesso-titulo" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-20 rounded-full bg-(--window-bg) px-3 py-1 text-[13px] text-(--text-primary)">
        Pular para o acesso
      </a>

      <main className="relative w-full max-w-[360px]">
        <section aria-labelledby="acesso-titulo" className="login-enter mac-window relative px-5 pb-5 pt-6 sm:px-8 sm:pb-6 sm:pt-7">
          <div className="absolute right-2.5 top-2.5">
            <Tooltip label={isDark ? "Usar o tema claro" : "Usar o tema escuro"} side="bottom">
              <button
                type="button"
                onClick={() => toggleTheme()}
                className="flex size-7 pointer-coarse:size-10 items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--control-fill) hover:text-(--text-primary)"
              >
                {isDark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
              </button>
            </Tooltip>
          </div>
          {content}
        </section>
        {LOGIN_MODE === "demo" && (
          <footer className="wallpaper-note mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px]">
            <span>
              Desenvolvido por <span className="font-bold text-white" style={{ fontFamily: "'JetBrains Mono', monospace" }}>AFN Systems</span>
            </span>
            <span aria-hidden>·</span>
            <a href={REPO_URL} className="text-white underline underline-offset-[3px] hover:text-white/90">Código-fonte no GitHub</a>
          </footer>
        )}
      </main>
    </div>
  );
}
