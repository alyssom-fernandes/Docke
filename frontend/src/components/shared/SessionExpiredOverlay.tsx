import { useEffect, useState, FormEvent } from "react";
import { Link } from "react-router-dom";
import { onSessionExpired } from "@/lib/sessionEvents";
import { useAuthContext } from "@/lib/AuthContext";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import Avatar from "@/components/ui/Avatar";

// Conta do modo demo — sem senha conhecida pelo usuário, então o token
// expirado é renovado automaticamente em vez de pedir senha. A senha nunca
// aparece aqui — o backend faz o login via /auth/demo-login.
const DEMO_EMAIL = "demo@docke.app";

/** Diz o que aconteceu de verdade, em vez de "senha incorreta" para tudo (A1-29). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loginErrorMessage(e: any): string {
  const status = e?.response?.status;
  const detail = e?.response?.data?.detail;
  if (!e?.response) return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  if (status === 423 || status === 429) return typeof detail === "string" ? detail : "Muitas tentativas. Espere alguns minutos e tente de novo.";
  if (status === 403) return typeof detail === "string" ? detail : "Esta conta foi desativada. Fale com o administrador.";
  if (status === 401 || status === 400) return "Senha incorreta. Confira e tente de novo.";
  return "Não foi possível entrar agora. Tente de novo em instantes.";
}

/**
 * Sessão expirada (A1-28..A1-30): Dialog acessível com o nome e o e-mail da
 * pessoa, campo do design system, erros que dizem o motivo, "Esqueci a senha"
 * e confirmação antes de sair (o que não foi salvo se perderia).
 */
export default function SessionExpiredOverlay() {
  const { user, login, loginDemo, logout } = useAuthContext();
  const [visible, setVisible] = useState(false);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmExit, setConfirmExit] = useState(false);

  useEffect(() => {
    return onSessionExpired(() => {
      if (!localStorage.getItem("docke_user")) return;
      if (user?.email === DEMO_EMAIL) {
        loginDemo().catch(() => { setVisible(true); setPassword(""); setError(""); });
        return;
      }
      setVisible(true);
      setPassword("");
      setError("");
      setConfirmExit(false);
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
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const nome = user.full_name || user.username;
  return (
    <Dialog onClose={() => {}} showClose={false} title="Sua sessão expirou" size="sm"
      description="Digite a senha para continuar de onde parou. O que você estava fazendo é concluído em seguida.">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex items-center gap-3 rounded-(--radius-control) bg-(--bg-hover) px-3 py-2.5">
          <Avatar name={nome} size="sm" />
          <div className="min-w-0">
            <p className="text-mac-body font-medium text-(--text-primary) truncate">{nome}</p>
            {user.email && <p className="text-mac-caption text-(--text-secondary) truncate">{user.email}</p>}
          </div>
        </div>
        <Input label="Senha" type="password" autoFocus autoComplete="current-password" value={password}
          onChange={(e) => { setPassword(e.target.value); setError(""); }} error={error || undefined} disabled={loading} />
        <Button type="submit" loading={loading} disabled={!password} className="w-full">Continuar</Button>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Link to="/login" state={{ forgot: true }} onClick={() => logout()} className="min-h-9 pointer-coarse:min-h-11 inline-flex items-center text-mac-body text-(--text-accent) hover:underline">
            Esqueci a senha
          </Link>
          {confirmExit ? (
            <span className="reveal inline-flex items-center gap-2 text-mac-caption text-(--text-secondary)">
              O que não foi salvo se perde.
              <button type="button" onClick={logout} className="min-h-9 pointer-coarse:min-h-11 font-medium text-(--text-danger) hover:underline">Sair mesmo</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmExit(true)}
              className="min-h-9 pointer-coarse:min-h-11 text-mac-body text-(--text-secondary) hover:text-(--text-primary) rounded-(--radius-control) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
              Sair da conta
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
