import { useState, FormEvent } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useCompany } from "@/lib/CompanyContext";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

interface IntegrityResult {
  total_events: number;
  intact: boolean;
  broken_count: number;
  first_broken: { event_id: string; event_created_at: string; reason: string } | null;
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
    <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6 mt-6">
      <h2 className="text-mac-body font-semibold text-[var(--text-primary)] mb-1">Integridade da trilha de auditoria</h2>
      <p className="text-mac-caption text-[var(--text-secondary)] mb-4">
        Cada evento registrado em Atividade carrega um hash encadeado ao anterior — qualquer alteração feita fora do fluxo normal do sistema quebra a cadeia a partir daquele ponto. Verifique a qualquer momento se a trilha continua íntegra.
      </p>
      <Button size="sm" variant="secondary" onClick={verify} loading={checking}>
        Verificar agora
      </Button>
      {result && (
        <div className={`mt-4 flex items-start gap-2 p-3 rounded-[var(--radius-control)] ${result.intact ? "bg-emerald-500/10" : "bg-red-500/10"}`}>
          {result.intact ? (
            <ShieldCheck className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          )}
          <div className="text-mac-caption">
            {result.intact ? (
              <p className="text-[var(--text-primary)]">Cadeia íntegra — {result.total_events} eventos verificados, nenhuma quebra encontrada.</p>
            ) : (
              <p className="text-red-600 dark:text-red-400">
                Quebra detectada em {result.broken_count} evento{result.broken_count > 1 ? "s" : ""}. O primeiro ponto adulterado foi registrado originalmente em{" "}
                {result.first_broken && new Date(result.first_broken.event_created_at).toLocaleString("pt-BR")}.
              </p>
            )}
          </div>
        </div>
      )}
      {error && <p className="text-mac-caption text-red-500 mt-3">{error}</p>}
    </div>
  );
}

export default function Security() {
  usePageTitle("Segurança");
  const { success, error: showError } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; new?: string; confirm?: string }>({});

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
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6">
        <form onSubmit={handleSubmit} className="space-y-4 max-w-[400px]">
          <Input
            label="Senha atual"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            error={errors.current}
            autoComplete="current-password"
          />
          <Input
            label="Nova senha"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={errors.new}
            autoComplete="new-password"
          />
          <Input
            label="Confirmar nova senha"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={errors.confirm}
            autoComplete="new-password"
          />
          <div className="flex justify-end pt-2">
            <Button type="submit" loading={saving} size="sm">
              Atualizar senha
            </Button>
          </div>
        </form>
      </div>
      <IntegritySection />
    </div>
  );
}
