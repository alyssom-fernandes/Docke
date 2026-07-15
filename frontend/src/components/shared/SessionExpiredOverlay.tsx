import { useEffect, useState, FormEvent } from "react";
import { Lock } from "lucide-react";
import { onSessionExpired } from "@/lib/sessionEvents";
import { useAuthContext } from "@/lib/AuthContext";
import Button from "@/components/ui/Button";
import Portal from "@/components/ui/Portal";

// Conta do modo demo — sem senha conhecida pelo usuário, então o token
// expirado é renovado automaticamente em vez de pedir senha (ver ADR do
// modo demo: a conta é compartilhada/pública, não faz sentido travar aqui).
// A senha nunca aparece aqui — o backend faz o login via /auth/demo-login,
// guardando a senha só como variável de ambiente (Fly secret).
const DEMO_EMAIL = "demo@docke.app";

export default function SessionExpiredOverlay() {
  const { user, login, loginDemo, logout } = useAuthContext();
  const [visible, setVisible] = useState(false);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    return onSessionExpired(() => {
      // Only show if there's a known user to re-authenticate
      if (!(localStorage.getItem("docke_token") || localStorage.getItem("docke_user"))) return;

      if (user?.email === DEMO_EMAIL) {
        loginDemo().catch(() => {
          // se a renovação silenciosa falhar por algum motivo, cai no fluxo normal
          setVisible(true);
          setPassword("");
          setError("");
        });
        return;
      }

      setVisible(true);
      setPassword("");
      setError("");
    });
  }, [user, loginDemo]);

  if (!visible || !user) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password || !user) return;
    setLoading(true);
    setError("");
    try {
      // Supabase Auth exige o e-mail real para login, não o username de exibição
      await login(user.email ?? user.username, password);
      setVisible(false);
      setPassword("");
    } catch {
      setError("Senha incorreta. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Portal>
    <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="modal-card glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal w-full max-w-[360px]">
        {/* Header */}
        <div className="flex flex-col items-center text-center px-8 pt-8 pb-6">
          <div className="w-12 h-12 bg-amber-50 dark:bg-amber-900/20 rounded-[12px] flex items-center justify-center mb-4">
            <Lock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-mac-callout font-semibold text-[var(--text-primary)]">Sessão expirada</h2>
          <p className="text-mac-body text-[var(--text-secondary)] mt-1">
            Digite sua senha para continuar como <span className="font-medium text-[var(--text-primary)]">@{user.username}</span>.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-8 pb-6 space-y-3">
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Senha"
            className="w-full h-10 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
          />
          {error && (
            <p className="text-mac-caption text-red-600 dark:text-red-400">{error}</p>
          )}
          <Button type="submit" loading={loading} disabled={!password} className="w-full">
            Continuar
          </Button>
          <button
            type="button"
            onClick={logout}
            className="w-full text-mac-body text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors duration-fast"
          >
            Sair da conta
          </button>
        </form>
      </div>
    </div>
    </Portal>
  );
}
