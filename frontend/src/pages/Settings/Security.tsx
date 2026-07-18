import { useState, FormEvent } from "react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

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
    </div>
  );
}
