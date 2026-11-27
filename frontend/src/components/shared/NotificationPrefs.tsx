import { useEffect, useState } from "react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Switch from "@/components/ui/Switch";
import { friendlyError } from "@/lib/errors";

/**
 * Quais avisos receber (achado A8-12 da avaliação de 25/11/2026). Só os de
 * rotina aparecem aqui; segurança, atraso, conferência e pedidos chegam
 * sempre (a API e o banco recusam desligar esses).
 */
const GRUPOS: { label: string; hint: string; types: string[] }[] = [
  { label: "Atividade nas pastas ancoradas", hint: "Alguém enviou, moveu ou excluiu numa pasta que você ancorou.", types: ["folder_activity"] },
  { label: "Versão nova de documento que você acompanha", hint: "Documento que você ancorou ou abriu nos últimos 30 dias.", types: ["version_added"] },
  { label: "Link aberto", hint: "Alguém abriu um link público que você criou (no máximo um aviso por dia por link).", types: ["share_accessed"] },
  { label: "Arquivo recebido por pedido", hint: "Chegou arquivo por um link de pedido que você criou.", types: ["upload_request_received"] },
  { label: "Obrigação perto de vencer", hint: "O aviso de atraso continua chegando sempre.", types: ["obligation_at_risk"] },
  { label: "Prazo de guarda a 90 e 30 dias", hint: "O aviso de 7 dias continua chegando sempre.", types: ["retention_expiring_90", "retention_expiring_30"] },
  { label: "Lixeira perto de esvaziar", hint: "Itens que serão apagados de vez em breve.", types: ["trash_expiring"] },
];

export default function NotificationPrefs() {
  const { error: showError } = useToast();
  const [muted, setMuted] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ muted: string[] }>("/notifications/preferences")
      .then((r) => setMuted(r.data.muted ?? []))
      .catch(() => setFailed(true));
  }, []);

  async function toggle(g: (typeof GRUPOS)[number], on: boolean) {
    if (!muted) return;
    const antes = muted;
    const next = on ? muted.filter((t) => !g.types.includes(t)) : [...new Set([...muted, ...g.types])];
    setMuted(next);
    setSaving(g.label);
    try {
      const r = await api.put<{ muted: string[] }>("/notifications/preferences", { muted: next });
      setMuted(r.data.muted);
    } catch (e) {
      setMuted(antes);
      showError(friendlyError(e, "Não foi possível salvar. Tente de novo."));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="pt-6 border-t border-(--border-default) space-y-3">
      <div>
        <h3 className="text-mac-body font-medium text-(--text-primary)">Avisos</h3>
        <p className="text-mac-caption text-(--text-tertiary) mt-0.5">
          Escolha os avisos de rotina que quer receber, na central e no celular. Segurança, atrasos, conferências e pedidos chegam sempre.
        </p>
      </div>
      {failed ? (
        <p role="alert" className="text-mac-caption text-(--text-danger)">Não carregou suas preferências de aviso. Recarregue a página para tentar de novo.</p>
      ) : muted === null ? (
        <div className="space-y-2" aria-label="Carregando">{[0, 1, 2].map((i) => <div key={i} className="h-10 max-w-[480px] rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>
      ) : (
        <ul className="space-y-3 max-w-[480px]">
          {GRUPOS.map((g) => {
            const on = !g.types.every((t) => muted.includes(t));
            return (
              <li key={g.label} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-mac-body text-(--text-primary)">{g.label}</p>
                  <p className="text-mac-caption text-(--text-tertiary)">{g.hint}</p>
                </div>
                <Switch checked={on} disabled={saving === g.label} onChange={(v: boolean) => toggle(g, v)} label={g.label} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
