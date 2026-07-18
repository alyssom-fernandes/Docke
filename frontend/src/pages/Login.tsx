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
    <div className="relative min-h-screen overflow-hidden flex flex-col items-center justify-center px-4" style={{ background: "var(--wallpaper)" }}>
      {/* Glow de acento em camadas — dá "profundidade de ambiente" ao primeiro
          contato, reforçando a identidade da marca sobre o wallpaper (G01). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-80 dark:opacity-100 transition-opacity duration-slow"
        style={{
          background:
            "radial-gradient(680px circle at 16% 12%, rgba(13,148,136,0.20), transparent 55%)," +
            "radial-gradient(620px circle at 84% 82%, rgba(20,184,166,0.16), transparent 55%)," +
            "radial-gradient(900px circle at 50% 118%, rgba(13,148,136,0.12), transparent 60%)",
        }}
      />
      {/* Spotlight suave atrás do formulário — foca o olhar no centro sem card */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] h-[520px] rounded-full blur-[120px] opacity-50 dark:opacity-30"
        style={{ background: "radial-gradient(circle, rgba(20,184,166,0.22), transparent 70%)" }}
      />

      <a href="#main-form" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 text-mac-body text-teal-500">
        Pular para formulário
      </a>
      <div className="relative w-full max-w-[320px]">
        {/* Logo */}
        <div className="flex flex-col items-center mb-6">
          <div className="brand-wordmark w-[124px] h-[36px]" role="img" aria-label="Docke" />
        </div>

        {/* Conteúdo direto na tela, sem card */}
        <div className="text-center">
          <h1 className="text-mac-body font-semibold text-[var(--text-primary)] mb-1">Bem-vindo de volta</h1>
          <p className="text-mac-caption text-[var(--text-secondary)] mb-5">Gerenciamento eletrônico de documentos.</p>

          <form id="main-form" onSubmit={handleSubmit} className="flex flex-col gap-3.5 text-left" noValidate>
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
              className="shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]"
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
              className="shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]"
            />
            <Button type="submit" loading={loading} className="w-full mt-1">
              Entrar
            </Button>
          </form>

          <div className="flex items-center gap-3 my-4 text-mac-caption text-[var(--text-tertiary)]">
            <div className="flex-1 h-px bg-[var(--border-default)]" />
            ou
            <div className="flex-1 h-px bg-[var(--border-default)]" />
          </div>

          <Button
            type="button"
            variant="secondary"
            onClick={handleDemoLogin}
            loading={demoLoading}
            disabled={loading}
            className="w-full"
          >
            Acessar modo demo
          </Button>
        </div>

        {/* Footer */}
        <div className="mt-7 text-center">
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
