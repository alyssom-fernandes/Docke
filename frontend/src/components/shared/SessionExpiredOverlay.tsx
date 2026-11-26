import { useEffect, useState, FormEvent } from "react";
import { onSessionExpired } from "@/lib/sessionEvents";
import { useAuthContext } from "@/lib/AuthContext";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";

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
      // Só faz sentido com alguém para reautenticar.
      if (!localStorage.getItem("docke_user")) return;

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

  // Sessão expirada (A1-28): Dialog com role=dialog, aria-modal, foco preso
  // e rótulo no campo; não fecha por fora (a saída é entrar de novo ou sair).
  return (
    <Dialog onClose={() => {}} showClose={false} title="Sessão expirada" size="sm"
      description={`Digite sua senha para continuar como @${user.username}. O que você estava fazendo é concluído em seguida.`}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Input label="Senha" type="password" autoFocus autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} error={error || undefined} />
        <Button type="submit" loading={loading} disabled={!password} className="w-full">Continuar</Button>
        <button type="button" onClick={logout}
          className="w-full min-h-9 text-mac-body text-(--text-secondary) hover:text-(--text-primary) transition-colors duration-fast rounded-[6px] focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
          Sair da conta
        </button>
      </form>
    </Dialog>
  );
}
