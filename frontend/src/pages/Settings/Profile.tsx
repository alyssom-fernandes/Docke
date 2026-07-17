import { useState, FormEvent, useEffect } from "react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";

export default function Profile() {
  usePageTitle("Perfil");
  const { user } = useAuthContext();
  const { success } = useToast();
  const [saving, setSaving] = useState(false);
  const [fullName, setFullName] = useState(user?.full_name ?? "");

  useEffect(() => {
    if (user) setFullName(user.full_name);
  }, [user]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      success("Perfil atualizado.");
    }, 800);
  }

  return (
    // Sem max-w/mx-auto no wrapper nem no cartão — as outras abas (Segurança,
    // Preferências, Retenção) usam cartão em largura cheia e limitam só o
    // CONTEÚDO interno quando faz sentido; antes o Perfil era a única aba que
    // encolhia e centralizava o cartão inteiro, dando um "salto" de largura
    // ao trocar de aba.
    <div className="space-y-6">
      <h2 className="text-mac-callout font-semibold text-[var(--text-primary)]">Perfil</h2>

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

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Nome completo"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Seu nome completo"
            />
            <Input
              label="Nome de usuário"
              value={user?.username ?? ""}
              placeholder="username"
              disabled
            />
            <div className="flex justify-end">
              <Button type="submit" loading={saving} size="sm">
                Salvar alterações
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
