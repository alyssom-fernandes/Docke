import { useState, FormEvent } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useCompany } from "@/lib/CompanyContext";
import { useAuthContext } from "@/lib/AuthContext";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface IntegrityResult {
  total_events: number;
  intact: boolean;
  broken_count: number;
  // event_id e event_created_at vêm nulos na quebra de "Cadeia truncada"
  // (eventos mais recentes apagados): não há evento para apontar.
  first_broken: { event_id: string | null; event_created_at: string | null; reason: string } | null;
}

// Fase 2.9: botão "verificar integridade da cadeia" — só admin/supremo, é
// ferramenta de auditoria, não algo que todo membro da empresa precisa ver.
function IntegritySection() {
  const { current } = useCompany();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<IntegrityResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    if (!current) return;
    setChecking(true);
    setError(null);
    try {
      const r = await api.get<IntegrityResult>("/activity/verify-integrity", { params: { company_id: current.id } });
      setResult(r.data);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Não foi possível verificar a integridade agora.");
    } finally {
      setChecking(false);
    }
  }

  if (!current || (current.permission_level !== "admin" && current.permission_level !== "supremo")) return null;

  return (
    <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-6 mt-6">
      <h2 className="text-mac-body font-semibold text-(--text-primary) mb-1">Integridade da trilha de auditoria</h2>
      <p className="text-mac-caption text-(--text-secondary) mb-4">
        Cada evento registrado em Atividade carrega um hash encadeado ao anterior. Um evento alterado fora do fluxo normal do sistema aparece como adulterado, e um evento apagado quebra a cadeia a partir dele, inclusive quando é o mais recente. Verifique a qualquer momento se a trilha continua íntegra.
      </p>
      <Button size="sm" variant="secondary" onClick={verify} loading={checking}>
        Verificar agora
      </Button>
      {result && (
        <div role="status" className={`mt-4 flex items-start gap-2 p-3 rounded-(--radius-control) ${result.intact ? "bg-emerald-500/10" : "bg-red-500/10"}`}>
          {result.intact ? (
            <ShieldCheck className="w-4 h-4 text-(--text-success) shrink-0 mt-0.5" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-(--text-danger) shrink-0 mt-0.5" />
          )}
          <div className="text-mac-caption">
            {result.intact ? (
              <p className="text-(--text-primary)">Cadeia íntegra — {result.total_events} eventos verificados, nenhuma quebra encontrada.</p>
            ) : (
              <p className="text-(--text-danger)">
                Quebra detectada em {result.broken_count} ponto{result.broken_count > 1 ? "s" : ""}. {result.first_broken?.reason}
                {result.first_broken?.event_created_at && (
                  <> O primeiro evento afetado foi registrado originalmente em {new Date(result.first_broken.event_created_at).toLocaleString("pt-BR")}.</>
                )}
              </p>
            )}
          </div>
        </div>
      )}
      {error && <p className="text-mac-caption text-(--text-danger) mt-3">{error}</p>}
    </div>
  );
}

export default function Security() {
  usePageTitle("Segurança");
  const { user } = useAuthContext();
  // Conta demo é compartilhada: o backend recusa a troca de senha dela.
  const isDemo = user?.username === "demo";
  const { success, error: showError } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; new?: string; confirm?: string }>({});
  const [show, setShow] = useState(false);
  // Força da senha (A8-10): requisitos visíveis antes de enviar, não só no erro.
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(newPassword)).length;
  const forca = !newPassword ? 0 : newPassword.length < 8 ? 1 : newPassword.length >= 12 && classes >= 3 ? 3 : classes >= 2 ? 2 : 1;
  const forcaTexto = ["", "Fraca", "Razoável", "Forte"][forca];

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!currentPassword) errs.current = "Informe a senha atual.";
    if (newPassword.length < 8) errs.new = "A nova senha deve ter no mínimo 8 caracteres.";
    if (newPassword !== confirmPassword) errs.confirm = "As senhas não coincidem.";
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
    setSaving(true);
    try {
      await api.post("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      success("Senha atualizada com sucesso.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível trocar a senha.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-6">
        {isDemo ? (
          <p className="text-mac-body text-(--text-secondary) max-w-[520px]">
            Na conta de demonstração a senha não pode ser trocada, porque todos os visitantes usam a mesma conta.
          </p>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4 max-w-[400px]">
          <Input
            label="Senha atual"
            type={show ? "text" : "password"}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            error={errors.current}
            autoComplete="current-password"
          />
          <Input
            label="Nova senha"
            type={show ? "text" : "password"}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={errors.new}
            autoComplete="new-password"
          />
          <div aria-live="polite">
            <div className="flex gap-1" aria-hidden="true">
              {[1, 2, 3].map((n) => <span key={n} className={`h-1 flex-1 rounded-full ${forca >= n ? (forca === 1 ? "bg-red-500" : forca === 2 ? "bg-amber-500" : "bg-green-600") : "bg-(--bg-hover)"}`} />)}
            </div>
            <p className="mt-1 text-mac-caption text-(--text-secondary)">
              {forcaTexto ? `Senha ${forcaTexto.toLowerCase()}. ` : ""}Pelo menos 8 caracteres; com 12 ou mais e letras, números e símbolos ela fica forte.
            </p>
          </div>
          <Input
            label="Confirmar nova senha"
            type={show ? "text" : "password"}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={errors.confirm}
            autoComplete="new-password"
          />
          <label className="flex items-center gap-2 text-mac-body text-(--text-primary)">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="w-4 h-4 accent-teal-600" /> Mostrar as senhas
          </label>
          <div className="flex justify-end pt-2">
            <Button type="submit" loading={saving} size="sm">
              Atualizar senha
            </Button>
          </div>
        </form>
        )}
      </div>
      <IntegritySection />
    </div>
  );
}
