import { useState, useEffect, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

export default function Login() {
  usePageTitle("Entrar");
  const { login, loginDemo, user } = useAuthContext();
  const { error: showError } = useToast();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  useEffect(() => {
    if (user) navigate("/dashboard", { replace: true });
  }, [user, navigate]);

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
      const msg = err?.response?.data?.detail ?? "E-mail ou senha incorretos.";
      showError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoLogin() {
    setDemoLoading(true);
    try {
      await loginDemo();
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      const msg = err?.response?.data?.detail ?? "Não foi possível acessar o modo demo agora.";
      showError(msg);
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--bg-page)] flex flex-col items-center justify-center px-4">
      {/* Glow de fundo — só visível em modo escuro (ADR-021: padrão da primeira sessão) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 dark:opacity-100 transition-opacity duration-slow"
        style={{
          background:
            "radial-gradient(600px circle at 20% 15%, rgba(13,148,136,0.16), transparent 60%), radial-gradient(500px circle at 85% 80%, rgba(13,148,136,0.10), transparent 60%)",
        }}
      />

      <a href="#main-form" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 text-mac-body text-teal-500">
        Pular para formulário
      </a>
      <div className="relative w-full max-w-[360px]">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="brand-wordmark w-[150px] h-[43px]" role="img" aria-label="Docke" />
        </div>

        {/* Conteúdo direto na tela, sem card — igual à referência */}
        <div className="text-center">
          <h1 className="text-mac-title3 font-semibold text-[var(--text-primary)] mb-1">Bem-vindo de volta</h1>
          <p className="text-mac-body text-[var(--text-secondary)] mb-6">Gerenciamento eletrônico de documentos.</p>

          <form id="main-form" onSubmit={handleSubmit} className="flex flex-col gap-4 text-left" noValidate>
            <Input
              label="E-mail"
              type="email"
              placeholder="voce@empresa.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email}
              autoComplete="email"
              autoFocus
              disabled={loading}
            />
            <Input
              label="Senha"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              autoComplete="current-password"
              disabled={loading}
            />
            <Button type="submit" loading={loading} className="w-full mt-1">
              Entrar
            </Button>
          </form>

          <div className="flex items-center gap-3 my-5 text-mac-caption text-[var(--text-tertiary)]">
            <div className="flex-1 h-px bg-[var(--border-default)]" />
            ou
            <div className="flex-1 h-px bg-[var(--border-default)]" />
          </div>

          <button
            type="button"
            onClick={handleDemoLogin}
            disabled={demoLoading || loading}
            className="w-full h-9 rounded-[var(--radius-control)] border border-[var(--border-default)] bg-[var(--bg-page)] text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast disabled:opacity-60"
          >
            {demoLoading ? "Entrando…" : "Acessar modo demo"}
          </button>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center">
          <p className="text-mac-caption text-[var(--text-tertiary)]">
            Desenvolvido por{" "}
            <span
              className="font-bold"
              style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--afn-brand)" }}
            >
              AFN Systems
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
