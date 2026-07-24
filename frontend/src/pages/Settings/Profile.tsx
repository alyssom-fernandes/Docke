import { useState, useEffect } from "react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import Input from "@/components/ui/Input";
import SaveBar from "@/components/shared/SaveBar";

export default function Profile() {
  usePageTitle("Perfil");
  const { user, updateProfile } = useAuthContext();
  const { success, error: showError } = useToast();
  const [saving, setSaving] = useState(false);
  const [fullName, setFullName] = useState(user?.full_name ?? "");

  useEffect(() => {
    if (user) setFullName(user.full_name);
  }, [user]);

  const dirty = fullName.trim() !== "" && fullName !== user?.full_name;

  async function handleSave() {
    setSaving(true);
    try {
      await updateProfile(fullName.trim());
      success("Perfil atualizado.");
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível atualizar o perfil.");
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    setFullName(user?.full_name ?? "");
  }

  return (
    // Sem max-w/mx-auto no wrapper nem no cartão — as outras abas (Segurança,
    // Preferências, Retenção) usam cartão em largura cheia e limitam só o
    // CONTEÚDO interno quando faz sentido; antes o Perfil era a única aba que
    // encolhia e centralizava o cartão inteiro, dando um "salto" de largura
    // ao trocar de aba.
    <div>
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6">
        <div className="max-w-[560px] space-y-6">
          {/* Avatar section */}
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-teal-600 flex items-center justify-center text-white text-mac-title3 font-semibold flex-shrink-0">
              {(user?.full_name ?? user?.username ?? "?")
                .split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
            </div>
            <div>
              <p className="text-mac-callout font-semibold text-[var(--text-primary)]">{user?.full_name}</p>
              <p className="text-mac-body text-[var(--text-secondary)]">@{user?.username}</p>
              {user?.role && (
                <span className="inline-block mt-1 text-mac-caption px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-500 font-medium capitalize">
                  {user.role}
                </span>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <Input
              label="Nome completo"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Seu nome completo"
            />
            {/* Valor não-editável mostrado como texto simples, não input
                desabilitado — honesto sobre não aceitar clique/edição (padrão
                macOS pra campos read-only em formulários de configuração). */}
            <div className="flex flex-col gap-1">
              <span className="text-mac-body font-medium text-[var(--text-secondary)]">Nome de usuário</span>
              <span className="text-mac-body text-[var(--text-primary)]">@{user?.username}</span>
            </div>
          </div>
        </div>
        {/* Fase 10.3: Save Bar só aparece com alteração pendente — sem
            botão "Salvar" estático quando nada mudou. */}
        <SaveBar visible={dirty} saving={saving} onSave={handleSave} onDiscard={handleDiscard} />
      </div>
    </div>
  );
}
