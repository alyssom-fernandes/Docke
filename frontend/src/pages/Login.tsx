import { useState, useEffect, useRef, FormEvent, CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Eye, EyeOff, ArrowLeft, ArrowRight, MailCheck, Fingerprint, KeyRound, UserRound, Loader2,
  ShieldCheck, Sun, Moon, ArrowBigUp, AlertCircle,
} from "lucide-react";
import { entrarComPasskey, passkeySuportada } from "@/lib/passkey";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import api, { prewarmApi } from "@/lib/api";
import { rememberChoice } from "@/lib/session";
import { toggleTheme, useIsDark } from "@/lib/theme";
import Checkbox from "@/components/ui/Checkbox";
import Wallpaper from "@/components/layout/Wallpaper";

const REPO_URL = "https://github.com/alyssom-fernandes/Docke";

// "demo" (padrão, a vitrine pública) mostra primeiro a demonstração;
// "empresa" (deploy de uso real) mostra só o acesso com conta — achado A1-03.
const LOGIN_MODE = (import.meta.env.VITE_LOGIN_MODE ?? "demo") as "demo" | "empresa";

// Depois deste tempo sem resposta, avisa que o servidor está ligando — a API
// na Fly desliga quando ociosa e a primeira requisição espera a máquina subir.
const SLOW_HINT_MS = 5_000;

// Widget da demonstração: nomes e arquivos que existem no seed. A cadeia é por
// empresa e cada "anterior" repete o hash de cima (prev_hash → hash).
const CHAIN_EXAMPLE = [
  { what: "Operador Demo enviou", file: "NF-e_Fornecedor_3.xml", where: "pasta Fiscal, 09:12", prev: "0c4e…19aa", hash: "7a3f…c2d1" },
  { what: "Visualizadora Demo abriu", file: "Holerite_2.pdf", where: "pasta RH, 10:47", prev: "7a3f…c2d1", hash: "e91b…04f7" },
  { what: "Operador Demo moveu", file: "Extrato_Banco_1.pdf", where: "para Bancário, 11:05", prev: "e91b…04f7", hash: "3d08…b6e5" },
];
const CHAIN_COMPANY = "Comércio Alfa Modelo Ltda";

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

/** Hora atual, trocando na virada de cada minuto (o relógio não mostra segundos). */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => { setNow(new Date()); schedule(); }, 60_000 - (Date.now() % 60_000) + 30);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

/** Data e hora grandes no topo, como na tela de bloqueio do Mac e do iPhone. */
function LockClock() {
  const now = useNow();
  const date = now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  const time = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return (
    <div aria-hidden="true" className="login-enter select-none text-center">
      <p className="lock-shadow text-[17px] font-semibold leading-[22px] text-white/95 sm:text-[21px] sm:leading-[26px]">{date}</p>
      <p className="lock-time mt-1">{time}</p>
    </div>
  );
}

/** Botão redondo de vidro com rótulo embaixo, como os de baixo da tela de login do Mac. */
function LockAction({ icon, label, onClick, disabled, busy }: {
  icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className="group flex w-[92px] flex-col items-center gap-1.5 rounded-[12px] py-1 disabled:opacity-60"
    >
      <span className="lock-circle size-9 transition-transform group-hover:bg-(--lock-glass-hover) group-active:scale-95 [&>svg]:size-4">
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : icon}
      </span>
      <span className="lock-shadow text-[11px] font-medium leading-[13px] text-white/90">{label}</span>
    </button>
  );
}

/** Círculo de vidro com o símbolo de quem está entrando (o "avatar" da tela de login). */
function LockAvatar({ children, size = 72 }: { children: ReactNode; size?: number }) {
  return (
    <span aria-hidden="true" className="lock-glass flex shrink-0 items-center justify-center rounded-full" style={{ width: size, height: size }}>
      {children}
    </span>
  );
}

function AboutWidget({ className = "" }: { className?: string }) {
  return (
    <section aria-labelledby="titulo" className={`lock-glass login-enter w-full max-w-[420px] rounded-[22px] p-4 text-left md:max-w-none ${className}`}>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-white/85">
        <span className="brand-mark size-3.5 bg-white!" aria-hidden /> Docke
      </p>
      <h1 id="titulo" className="mt-2 text-[19px] font-bold leading-[24px] tracking-[-0.01em]" style={{ textWrap: "balance" } as CSSProperties}>
        Os documentos das suas empresas, achados em segundos.
      </h1>
      <p className="mt-1.5 text-[13px] leading-[18px] text-white/85">
        Notas fiscais, folha e contratos pesquisáveis até no texto digitalizado, prazos de obrigações que avisam antes
        de vencer e um registro de tudo o que aconteceu com cada documento, que prova que nada foi alterado.
      </p>
    </section>
  );
}

function ChainWidget({ className = "" }: { className?: string }) {
  return (
    <section aria-labelledby="trilha" className={`lock-glass login-enter login-enter-2 w-full max-w-[420px] rounded-[22px] p-4 text-left md:max-w-none ${className}`}>
      <h2 id="trilha" className="flex items-center gap-1.5 text-[12px] font-semibold text-white/85">
        <ShieldCheck className="size-3.5" aria-hidden /> Cada ação fica registrada e encadeada
      </h2>
      <ol className="login-chain relative mt-3">
        {CHAIN_EXAMPLE.map((e, i) => (
          <li key={e.hash} className="relative flex items-start justify-between gap-3 pb-2.5 pl-5">
            <span className="min-w-0 text-[12.5px] leading-[16px]">
              {e.what} <span className="font-semibold">{e.file}</span>
              <span className="block text-[11px] leading-[15px] text-white/75">{CHAIN_COMPANY}, {e.where}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap text-right font-mono text-[10.5px] leading-[15px] text-white/80">
              anterior <span className={i === 0 ? "" : "text-[#9FF3E4]"}>{e.prev}</span>
              <br />
              <span className="text-[#9FF3E4]">registro {e.hash}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11px] leading-[15px] text-white/75">
        Exemplo com dados fictícios. Cada registro carrega o código do anterior: se alguém alterar ou apagar um
        registro, a verificação mostra exatamente onde.
      </p>
    </section>
  );
}

export default function Login() {
  usePageTitle("Entrar");
  const { login, loginDemo, user, loginWithSession } = useAuthContext();
  const navigate = useNavigate();
  const returnTo = useReturnTo();
  const isDark = useIsDark();

  // Vindo de "Esqueci a senha" na sessão expirada (A1-29), abre direto na recuperação.
  const [view, setView] = useState<View>(() => (window.history.state?.usr?.forgot ? "forgot" : "login"));
  // Na demonstração, o acesso com conta fica atrás do "Outra conta…", como no login do Mac.
  const [accountOpen, setAccountOpen] = useState(LOGIN_MODE === "empresa");
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
  const emailRef = useRef<HTMLInputElement>(null);
  const otherTileRef = useRef<HTMLButtonElement>(null);
  const openedByClick = useRef(false);

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

  // Abrir "Outra conta…" leva o foco ao e-mail; voltar devolve ao bloco.
  useEffect(() => {
    if (!openedByClick.current) return;
    if (accountOpen) emailRef.current?.focus();
    else otherTileRef.current?.focus();
  }, [accountOpen]);

  function trackCaps(e: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false);
  }

  function goTo(next: View) {
    setView(next);
    setFormError("");
    setErrors({});
  }

  function setAccount(open: boolean) {
    openedByClick.current = true;
    setAccountOpen(open);
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
  const showTiles = LOGIN_MODE === "demo" && view === "login" && !accountOpen;
  const fieldError = "lock-shadow mt-1.5 self-start pl-4 text-[12px] font-medium leading-4 text-[#FFD5CF]";
  const arrowButton = "flex size-7 shrink-0 items-center justify-center rounded-full bg-white/25 text-white hover:bg-white/35 disabled:opacity-60";

  const formErrorBox = formError && (
    <div
      ref={formErrorRef}
      tabIndex={-1}
      role="alert"
      className="lock-glass login-reveal mt-3 flex w-full items-start gap-2 rounded-[14px] px-3.5 py-2.5 text-left text-[13px] leading-[18px] text-white focus:outline-hidden"
    >
      <AlertCircle className="mt-px size-4 shrink-0 text-[#FFA49A]" aria-hidden />
      <span>{formError}</span>
    </div>
  );

  // Cabeça do acesso: o círculo de quem entra e o título da etapa.
  const head = (avatar: ReactNode, title: string) => (
    <>
      <LockAvatar>{avatar}</LockAvatar>
      <h2 id="acesso-titulo" tabIndex={-1} className="lock-shadow mt-3 mb-4 text-[17px] font-semibold leading-[22px] focus:outline-hidden">
        {title}
      </h2>
    </>
  );

  const actions = (children: ReactNode) => <div className="mt-5 flex justify-center gap-1">{children}</div>;
  const backToLogin = <LockAction icon={<ArrowLeft aria-hidden />} label="Voltar" onClick={() => goTo("login")} />;

  let access: ReactNode;
  if (showTiles) {
    access = (
      <>
        <h2 id="acesso-titulo" tabIndex={-1} className="sr-only">Entrar no Docke</h2>
        <div className="flex items-start justify-center gap-2 sm:gap-8">
          <button
            type="button"
            onClick={handleDemoLogin}
            disabled={demoBusy}
            aria-busy={demoBusy || undefined}
            aria-label={demo === "error" ? "Tentar abrir a demonstração de novo" : "Explorar a demonstração"}
            aria-describedby="demo-descricao"
            className="group flex w-[176px] flex-col items-center rounded-[16px] pb-1"
          >
            <span className="lock-glass flex size-[88px] items-center justify-center rounded-full transition-transform group-hover:bg-(--lock-glass-hover) group-active:scale-[0.97]">
              {demoBusy ? <Loader2 className="size-8 animate-spin" aria-hidden /> : <span className="brand-mark size-11 bg-white!" aria-hidden />}
            </span>
            <span className="lock-shadow mt-2.5 text-[15px] font-semibold leading-5">
              {demo === "error" ? "Tentar de novo" : "Demonstração"}
            </span>
            <span id="demo-descricao" className="lock-shadow text-[12px] leading-4 text-white/85">3 empresas fictícias,<br />sem cadastro e sem senha</span>
          </button>
          <button
            ref={otherTileRef}
            type="button"
            onClick={() => setAccount(true)}
            disabled={demoBusy}
            className="group flex w-[176px] flex-col items-center rounded-[16px] pb-1 disabled:opacity-60"
          >
            <span className="lock-glass flex size-[88px] items-center justify-center rounded-full transition-transform group-hover:bg-(--lock-glass-hover) group-active:scale-[0.97]">
              <UserRound className="size-10 text-white/90" strokeWidth={1.4} aria-hidden />
            </span>
            <span className="lock-shadow mt-2.5 text-[15px] font-semibold leading-5">Outra conta…</span>
            <span className="lock-shadow text-[12px] leading-4 text-white/85">E-mail e senha</span>
          </button>
        </div>
        <div role="status" aria-live="polite" className="mt-3 min-h-5 text-center">
          {demoBusy && (
            <p className="lock-shadow login-reveal text-[13px] leading-[18px] text-white/90">
              {demo === "slow" ? "O servidor estava em repouso e está ligando. Leva uns 10 segundos." : "Abrindo a demonstração…"}
            </p>
          )}
        </div>
        {demo === "error" && (
          <div role="alert" className="lock-glass login-reveal mt-2 w-full rounded-[16px] px-4 py-3 text-center text-[13px] leading-[18px]">
            <strong className="block font-semibold">Não foi possível abrir a demonstração agora.</strong>
            <span className="text-white/85">O servidor não respondeu a tempo. Tente de novo em alguns minutos.</span>
          </div>
        )}
        {formErrorBox}
      </>
    );
  } else if (view === "login") {
    access = (
      <>
        {LOGIN_MODE === "empresa"
          ? head(<span className="brand-mark size-9 bg-white!" />, "Entrar no Docke")
          : head(<UserRound className="size-9 text-white/90" strokeWidth={1.4} />, "Outra conta")}
        <form onSubmit={handleSubmit} noValidate className="flex w-full flex-col items-center" aria-describedby={formError ? "login-erro" : undefined}>
          <label htmlFor="login-email" className="sr-only">E-mail</label>
          <input
            ref={emailRef}
            id="login-email"
            type="email"
            inputMode="email"
            placeholder="E-mail"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            disabled={loading}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "login-email-erro" : undefined}
            className="lock-field"
          />
          {errors.email && <p id="login-email-erro" className={fieldError}>{errors.email}</p>}
          <div className={`relative mt-2.5 w-full ${shake ? "lock-shake" : ""}`} onAnimationEnd={() => setShake(false)}>
            <label htmlFor="login-senha" className="sr-only">Senha</label>
            <input
              id="login-senha"
              type={showPassword ? "text" : "password"}
              placeholder="Senha"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyUp={trackCaps}
              onKeyDown={trackCaps}
              onBlur={() => setCapsLock(false)}
              autoComplete="current-password"
              disabled={loading}
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={[errors.password ? "login-senha-erro" : "", capsLock ? "login-caps" : ""].filter(Boolean).join(" ") || undefined}
              className={`lock-field ${capsLock ? "pr-[92px]" : "pr-[72px]"}`}
            />
            <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
              {capsLock && <ArrowBigUp className="mr-0.5 size-4 text-white/85" aria-hidden />}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                aria-pressed={showPassword}
                className="flex size-7 items-center justify-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
              >
                {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              </button>
              <button type="submit" aria-label="Entrar" disabled={loading || demoBusy} aria-busy={loading || undefined} className={arrowButton}>
                {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowRight className="size-4" strokeWidth={2.25} aria-hidden />}
              </button>
            </div>
          </div>
          {errors.password && <p id="login-senha-erro" className={fieldError}>{errors.password}</p>}
          {capsLock && <p id="login-caps" className="lock-shadow mt-1.5 self-start pl-4 text-[12px] leading-4 text-white/85">A tecla Caps Lock está ativada.</p>}
          <label className="lock-shadow mt-3.5 flex min-h-8 cursor-pointer select-none items-center gap-2 text-[13px] text-white/90 pointer-coarse:min-h-11">
            <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Manter conectado neste computador
          </label>
          <div id="login-erro" className="w-full">{formErrorBox}</div>
        </form>
        {actions(
          <>
            {LOGIN_MODE === "demo" && <LockAction icon={<ArrowLeft aria-hidden />} label="Voltar" onClick={() => setAccount(false)} />}
            <LockAction icon={<KeyRound aria-hidden />} label="Esqueci a senha" onClick={() => goTo("forgot")} />
            {passkeySuportada() && (
              <LockAction icon={<Fingerprint aria-hidden />} label="Digital ou rosto" onClick={entrarPasskey} busy={passkeyBusy} disabled={loading || demoBusy} />
            )}
          </>
        )}
      </>
    );
  } else if (view === "forgot") {
    access = (
      <>
        {head(<KeyRound className="size-8 text-white/90" strokeWidth={1.6} />, "Criar uma senha nova")}
        <form onSubmit={handleForgot} noValidate className="login-reveal flex w-full flex-col items-center">
          <p className="lock-shadow mb-3.5 text-center text-[13px] leading-[18px] text-white/90">
            Informe o e-mail da sua conta. Enviamos um link para você criar uma senha nova; ele vale por 1 hora.
          </p>
          <div className="relative w-full">
            <label htmlFor="recuperar-email" className="sr-only">E-mail</label>
            <input
              id="recuperar-email"
              type="email"
              inputMode="email"
              placeholder="E-mail"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              disabled={loading}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? "recuperar-email-erro" : undefined}
              className="lock-field pr-10"
            />
            <button type="submit" aria-label="Enviar link" disabled={loading} aria-busy={loading || undefined} className={`absolute right-1 top-1/2 -translate-y-1/2 ${arrowButton}`}>
              {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowRight className="size-4" strokeWidth={2.25} aria-hidden />}
            </button>
          </div>
          {errors.email && <p id="recuperar-email-erro" className={fieldError}>{errors.email}</p>}
          {formErrorBox}
        </form>
        {actions(backToLogin)}
      </>
    );
  } else {
    access = (
      <>
        {head(<MailCheck className="size-8 text-white/90" strokeWidth={1.6} />, "Confira seu e-mail")}
        <p role="status" className="lock-shadow login-reveal text-center text-[13px] leading-[18px] text-white/90">
          Se <strong className="font-semibold text-white">{email.trim()}</strong> tiver cadastro, chega em alguns minutos um link para
          criar a senha nova. Confira também a caixa de spam. Se não chegar, fale com o administrador da sua empresa.
        </p>
        {actions(backToLogin)}
      </>
    );
  }

  return (
    <div className="lock-screen relative isolate min-h-dvh overflow-x-hidden">
      <Wallpaper fixed />

      <a href="#acesso-titulo" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-20 text-[13px] text-white underline">
        Pular para o acesso
      </a>

      {/* Canto de cima, como os itens de status da tela de bloqueio */}
      <button
        type="button"
        onClick={() => toggleTheme()}
        aria-label={isDark ? "Usar o tema claro" : "Usar o tema escuro"}
        title={isDark ? "Usar o tema claro" : "Usar o tema escuro"}
        className="lock-circle absolute right-4 top-[calc(14px+env(safe-area-inset-top))] z-10 size-8"
      >
        {isDark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
      </button>

      <main className="relative mx-auto flex min-h-dvh w-full max-w-[1100px] flex-col items-center px-5 pb-[calc(18px+env(safe-area-inset-bottom))] pt-[calc(44px+env(safe-area-inset-top))] sm:px-8 sm:pt-14">
        {(LOGIN_MODE === "empresa" || !showTiles) && <h1 className="sr-only">Docke</h1>}
        <LockClock />

        {/* Na demonstração, dois widgets explicam o Docke enquanto se escolhe como entrar. */}
        {showTiles && (
          <div className="contents md:order-1 md:mt-9 md:grid md:w-full md:max-w-[880px] md:grid-cols-2 md:items-stretch md:gap-4">
            <AboutWidget className="order-1 mt-7 md:mt-0" />
            <ChainWidget className="order-4 mt-10 md:order-1 md:mt-0" />
          </div>
        )}

        <div aria-hidden className="order-2 min-h-10 flex-1" />

        <section aria-labelledby="acesso-titulo" className={`login-enter login-enter-2 order-3 flex w-full flex-col items-center ${showTiles ? "max-w-[420px]" : "max-w-[300px]"}`}>
          {access}
        </section>

        <footer className="lock-shadow order-5 mt-8 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[12px] text-white/80">
          {LOGIN_MODE === "demo" ? (
            <>
              <span>
                Desenvolvido por{" "}
                <span className="font-bold text-white" style={{ fontFamily: "'JetBrains Mono', monospace" }}>AFN Systems</span>
              </span>
              <span aria-hidden>·</span>
              <a href={REPO_URL} className="text-white underline underline-offset-[3px] hover:text-white/90">
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
