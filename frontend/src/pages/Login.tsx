import { useState, useEffect, useRef, FormEvent, CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import { prewarmApi } from "@/lib/api";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

const REPO_URL = "https://github.com/alyssom-fernandes/Docke";

// Depois deste tempo sem resposta, avisa que o servidor está ligando — a API
// na Fly desliga quando ociosa e a primeira requisição espera a máquina subir.
const SLOW_HINT_MS = 5_000;

// Exemplo ilustrativo com nomes e arquivos que existem no seed da demo
// (backend/app/seed/demo_data.py). A cadeia é por empresa — por isso os
// quatro eventos são da mesma — e cada "anterior" repete o hash de cima,
// que é exatamente o encadeamento de activity_log (prev_hash → hash).
const CHAIN_EXAMPLE = [
  { what: "Operador Demo enviou NF-e_Fornecedor_3.xml", where: "pasta Fiscal, 09:12", prev: "0c4e…19aa", hash: "7a3f…c2d1" },
  { what: "Visualizadora Demo visualizou Holerite_2.pdf", where: "pasta RH, 10:47", prev: "7a3f…c2d1", hash: "e91b…04f7" },
  { what: "Operador Demo moveu Extrato_Banco_1.pdf", where: "para Bancário, 11:05", prev: "e91b…04f7", hash: "3d08…b6e5" },
  { what: "Visualizadora Demo ancorou Procuração_1.pdf", where: "pasta Contratos, 11:30", prev: "3d08…b6e5", hash: "5fc2…a918" },
];

type DemoState = "idle" | "loading" | "slow" | "error";

export default function Login() {
  usePageTitle("Entrar");
  const { login, loginDemo, user } = useAuthContext();
  const { error: showError } = useToast();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [demo, setDemo] = useState<DemoState>("idle");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const slowTimer = useRef<number>();

  useEffect(() => {
    if (user) navigate("/dashboard", { replace: true });
  }, [user, navigate]);

  // Acorda a API enquanto o visitante lê a tela.
  useEffect(() => {
    prewarmApi();
    return () => window.clearTimeout(slowTimer.current);
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!email) errs.email = "Informe o e-mail.";
    if (!password) errs.password = "Informe a senha.";
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
    setLoading(true);
    try {
      await login(email, password);
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      const msg = err?.response?.data?.detail
        ?? (err?.response ? "E-mail ou senha incorretos." : "Não foi possível conectar ao servidor agora. Tente de novo em alguns minutos.");
      showError(msg);
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
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      window.clearTimeout(slowTimer.current);
      // Resposta do servidor (ex.: 423 de muitas tentativas) tem mensagem
      // própria; sem resposta nenhuma, o servidor está fora do ar.
      const detail = err?.response?.data?.detail;
      if (detail) {
        showError(detail);
        setDemo("idle");
      } else {
        setDemo("error");
      }
    }
  }

  const demoBusy = demo === "loading" || demo === "slow";

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

      <a href="#demo" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-10 text-mac-body text-teal-500">
        Pular para o acesso
      </a>

      <main
        className="relative mx-auto grid min-h-screen max-w-[1200px] grid-cols-1 content-start gap-10 px-6 pb-7 pt-10
          lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-[auto_1fr_auto] lg:content-center lg:gap-x-20 lg:gap-y-11 lg:px-14 lg:pt-14 lg:pb-8"
      >
        {/* Apresentação */}
        <section aria-labelledby="titulo" className="lg:col-start-1 lg:row-start-1">
          <div className="brand-wordmark block w-[124px] h-[36px]" role="img" aria-label="Docke" />
          <h1
            id="titulo"
            className="mt-9 max-w-[22ch] text-[34px] leading-[40px] font-semibold tracking-[-0.022em] text-[var(--text-primary)] lg:mt-12 lg:text-[42px] lg:leading-[48px]"
            style={{ textWrap: "balance" } as CSSProperties}
          >
            Documentos de várias empresas, organizados e auditáveis.
          </h1>
          <p className="mt-4 max-w-[52ch] text-[15px] leading-[23px] text-[var(--text-secondary)] lg:text-[16px] lg:leading-[25px]">
            Notas fiscais, folha e contratos com busca dentro do texto digitalizado, prazos de obrigações,
            retenção legal e uma trilha de auditoria encadeada por hash.
          </p>
        </section>

        {/* Acesso */}
        <section aria-labelledby="acesso" className="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">
          <div className="glass-panel glass-blur-panel glass-shadow rounded-[16px] px-[18px] py-[22px] sm:p-7">
            <h2 id="acesso" className="text-mac-title2 font-semibold text-[var(--text-primary)]">Ver o Docke por dentro</h2>
            <p className="mt-1.5 mb-[18px] text-mac-body leading-[19px] text-[var(--text-secondary)]">
              Abre uma conta de demonstração com 3 empresas fictícias. Sem cadastro.
            </p>

            <Button
              id="demo"
              type="button"
              onClick={handleDemoLogin}
              loading={demoBusy}
              disabled={loading}
              className="w-full !h-10 !text-[14px] font-semibold"
            >
              {demoBusy ? "Abrindo a demonstração…" : demo === "error" ? "Tentar de novo" : "Explorar a demonstração"}
            </Button>

            <div role="status" aria-live="polite">
              {demo === "slow" && (
                <p className="mt-3 text-mac-footnote leading-[18px] text-[var(--text-secondary)]">
                  O servidor estava em repouso e está ligando. Aguarde mais alguns segundos.
                </p>
              )}
            </div>
            {demo === "error" && (
              <div role="alert" className="mt-3.5 rounded-[12px] border border-[#e07a88]/30 bg-[#e07a88]/[0.08] px-4 py-3.5">
                <p className="text-mac-body leading-[19px] text-[var(--text-secondary)]">
                  <strong className="mb-1 block font-semibold text-[var(--text-primary)]">Não foi possível abrir a demonstração agora.</strong>
                  O servidor está desligado ou demorou para ligar. Tente de novo em alguns minutos.
                </p>
                <a href={REPO_URL} className="mt-2.5 inline-block text-mac-body text-teal-600 underline underline-offset-[3px] hover:text-teal-500 dark:text-teal-200 dark:hover:text-teal-100">
                  Ver o código no GitHub
                </a>
              </div>
            )}

            <div className="mt-6 mb-4 flex items-center gap-3 text-mac-footnote text-[var(--text-tertiary)]">
              <div className="h-px flex-1 bg-[var(--border-default)]" />
              ou entre com sua conta
              <div className="h-px flex-1 bg-[var(--border-default)]" />
            </div>

            <form id="main-form" onSubmit={handleSubmit} className="flex flex-col gap-3 text-left" noValidate>
              <Input
                label="E-mail"
                type="email"
                placeholder="voce@empresa.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={errors.email}
                autoComplete="email"
                disabled={loading}
                className="shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]"
              />
              <Input
                label="Senha"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={errors.password}
                autoComplete="current-password"
                disabled={loading}
                className="shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]"
              />
              <Button type="submit" variant="secondary" loading={loading} disabled={demoBusy} className="w-full mt-1 !h-9">
                Entrar
              </Button>
            </form>
          </div>
        </section>

        {/* Trilha de exemplo */}
        <section aria-labelledby="trilha" className="lg:col-start-1 lg:row-start-2">
          <h2 id="trilha" className="sr-only">Exemplo de trilha de auditoria</h2>
          <ol className="login-chain relative max-w-[560px]">
            {CHAIN_EXAMPLE.map((e, i) => (
              <li
                key={e.hash}
                className={`relative grid grid-cols-1 pb-[18px] pl-[30px] sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-x-5 ${i === 3 ? "hidden sm:grid" : ""}`}
              >
                <span className="text-[14px] leading-5 text-[var(--text-primary)]">{e.what}</span>
                <span className="mt-0.5 text-mac-footnote leading-[17px] text-[var(--text-tertiary)] sm:col-start-1">
                  Comércio Alfa Modelo Ltda, {e.where}
                </span>
                <span className="mt-1 whitespace-nowrap font-mono text-[11.5px] leading-[17px] text-[var(--text-tertiary)] sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:text-right">
                  anterior <span className={i === 0 ? "" : "text-teal-600 dark:text-teal-200"}>{e.prev}</span>
                  <br />
                  <span className="text-teal-600 dark:text-teal-200">hash {e.hash}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-1 max-w-[54ch] text-[12.5px] leading-[19px] text-[var(--text-tertiary)]">
            Exemplo com dados fictícios da demonstração. Cada registro guarda o hash do anterior, então alterar um deles
            quebra a sequência inteira.
          </p>
        </section>

        <footer className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-mac-footnote text-[var(--text-tertiary)] lg:col-span-2 lg:row-start-3">
          <span>
            Desenvolvido por{" "}
            <span className="font-bold" style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--afn-brand)" }}>
              AFN Systems
            </span>
          </span>
          <a href={REPO_URL} className="text-teal-600 underline underline-offset-[3px] hover:text-teal-500 dark:text-teal-200 dark:hover:text-teal-100">
            Código-fonte no GitHub
          </a>
        </footer>
      </main>
    </div>
  );
}
