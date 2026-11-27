import { useEffect, useState, type ElementType } from "react";
import { Link } from "react-router-dom";
import { Link2, Inbox, CalendarClock, Stethoscope, MessageSquare, ScanText, ShieldCheck } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useAuthContext } from "@/lib/AuthContext";
import { useCompany, useFeatures, DEFAULT_FEATURES, type FeatureKey, type Features as FeatureMap } from "@/lib/CompanyContext";
import Switch from "@/components/ui/Switch";
import Dropdown from "@/components/ui/Dropdown";
import ConfirmModal from "@/components/ui/ConfirmModal";

interface Recurso {
  key: FeatureKey;
  icon: ElementType;
  color: string;
  title: string;
  text: string;
  /** Aviso antes de desligar, quando há efeito fora da tela (links que param de abrir etc.). */
  offWarning?: string;
  /** Depende de outro recurso ligado. */
  requires?: FeatureKey;
}

const GRUPOS: { title: string; items: Recurso[] }[] = [
  {
    title: "Compartilhar",
    items: [
      {
        key: "links", icon: Link2, color: "bg-blue-500", title: "Compartilhamento por link",
        text: "Links para quem está fora do Docke abrir documentos e pastas.",
        offWarning: "Os links que já existem param de abrir para quem os recebeu. Nada é apagado: ao ligar de novo, os links que ainda estavam valendo voltam a abrir.",
      },
      {
        key: "pedidos", icon: Inbox, color: "bg-orange-500", title: "Pedidos de arquivo por link",
        text: "Quem não tem conta envia arquivos por um link, direto na pasta escolhida.",
        offWarning: "Os pedidos abertos param de receber arquivos. O que já chegou continua nas pastas.",
      },
    ],
  },
  {
    title: "Organizar",
    items: [
      {
        key: "obrigacoes", icon: CalendarClock, color: "bg-red-500", title: "Obrigações e prazos",
        text: "Licenças, certidões e obrigações com prazo, responsável e aviso antes de vencer.",
        offWarning: "A aba Obrigações some para todos e os avisos de prazo param. O cadastro fica guardado e volta ao ligar de novo.",
      },
      {
        key: "exames", icon: Stethoscope, color: "bg-green-600", title: "Exames ocupacionais (ASO)",
        text: "Exames por colaborador, com o vencimento de cada um, dentro de Obrigações.", requires: "obrigacoes",
      },
      {
        key: "comentarios", icon: MessageSquare, color: "bg-purple-500", title: "Comentários e anotações",
        text: "Conversas e marcações nas páginas dos documentos.",
      },
    ],
  },
  {
    title: "Leitura e busca",
    items: [
      {
        key: "ocr", icon: ScanText, color: "bg-slate-500", title: "Leitura de texto",
        text: "Lê o texto de PDFs e imagens para a busca achar pelo conteúdo.",
        offWarning: "Os arquivos novos ficam na fila, sem texto para a busca, e são lidos quando você ligar de novo. O que já foi lido continua pesquisável.",
      },
    ],
  },
  {
    title: "Privacidade",
    items: [
      {
        key: "canal_titular", icon: ShieldCheck, color: "bg-teal-600", title: "Canal do titular (LGPD)",
        text: "Página pública para titulares pedirem acesso, correção ou exclusão dos seus dados.",
      },
    ],
  },
];

const MAXIMOS = [
  { value: "", label: "Sem limite" },
  { value: "1", label: "1 dia" },
  { value: "7", label: "7 dias" },
  { value: "30", label: "30 dias" },
  { value: "90", label: "90 dias" },
  { value: "365", label: "1 ano" },
];

/**
 * Ajustes → Recursos: o que a empresa usa do Docke. Desligar esconde o recurso
 * de todos e faz a API recusar o que for novo; nada é apagado.
 */
export default function Features() {
  const { current, setFeatures } = useCompany();
  const { user } = useAuthContext();
  const { success, error: showError } = useToast();
  const recursos = useFeatures();
  const [busy, setBusy] = useState<FeatureKey | null>(null);
  const [confirm, setConfirm] = useState<Recurso | null>(null);
  const [pol, setPol] = useState<{ require_password: boolean; max_days: number | null } | null>(null);
  const canEdit = user?.role === "supremo" || current?.permission_level === "admin";

  // Recursos frescos do servidor (outra pessoa pode ter mudado desde o login).
  useEffect(() => {
    if (!current) return;
    api.get(`/companies/${current.id}/features`).then((r) => setFeatures(current.id, { ...DEFAULT_FEATURES, ...r.data.features })).catch(() => {});
    api.get(`/companies/${current.id}/share-policy`).then((r) => setPol(r.data)).catch(() => setPol({ require_password: false, max_days: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  async function mudar(item: Recurso, ligado: boolean) {
    if (!current) return;
    setBusy(item.key);
    const antes = recursos;
    setFeatures(current.id, { ...recursos, [item.key]: ligado } as FeatureMap);
    try {
      const r = await api.put(`/companies/${current.id}/features`, { features: { [item.key]: ligado } });
      setFeatures(current.id, { ...DEFAULT_FEATURES, ...r.data.features });
      success(`${item.title}: ${ligado ? "ligado" : "desligado"}.`);
    } catch (e) {
      setFeatures(current.id, antes);
      showError(friendlyError(e, "Não foi possível salvar. Tente de novo."));
    } finally {
      setBusy(null);
    }
  }

  async function salvarPolitica(next: { require_password: boolean; max_days: number | null }) {
    if (!current) return;
    const antes = pol;
    setPol(next);
    try {
      await api.put(`/companies/${current.id}/share-policy`, next);
      success("Regras dos links salvas.");
    } catch (e) {
      setPol(antes);
      showError(friendlyError(e, "Não foi possível salvar as regras dos links. Tente de novo."));
    }
  }

  if (!current) return null;

  return (
    <div className="space-y-6">
      <p className="text-[13px] leading-[18px] text-(--text-secondary)">
        Ligue só o que {current.name} usa. Desligar esconde o recurso de todos e não apaga nada: ao ligar de novo, tudo volta como estava.
        {!canEdit && " Só quem administra a empresa muda estes ajustes."}
      </p>

      {GRUPOS.map((g) => (
        <section key={g.title} aria-labelledby={`rec-${g.title}`}>
          <h3 id={`rec-${g.title}`} className="mb-1.5 px-1 text-[13px] font-semibold text-(--text-primary)">{g.title}</h3>
          <div className="mac-group divide-y divide-(--separator-subtle) overflow-hidden">
            {g.items.map((item) => {
              const dependeDesligado = !!item.requires && !recursos[item.requires];
              const ligado = recursos[item.key] && !dependeDesligado;
              return (
                <div key={item.key}>
                  <div className="flex items-start gap-3 px-3 py-2.5">
                    <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[7px] ${item.color}`} aria-hidden>
                      <item.icon className="size-4 text-white" strokeWidth={2} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p id={`rec-${item.key}`} className="text-[13px] font-medium leading-[18px] text-(--text-primary)">{item.title}</p>
                      <p className="text-[12px] leading-4 text-(--text-secondary)">
                        {item.text}
                        {dependeDesligado && " Depende de Obrigações e prazos ligado."}
                        {item.key === "canal_titular" && recursos.canal_titular && (
                          <> <Link to="/settings/privacy" className="text-(--text-accent) hover:underline">Ver o endereço do canal</Link></>
                        )}
                      </p>
                    </div>
                    <div className="pt-0.5">
                      <Switch
                        checked={ligado}
                        disabled={!canEdit || busy !== null || dependeDesligado}
                        label={item.title}
                        onChange={(v) => (!v && item.offWarning ? setConfirm(item) : mudar(item, v))}
                      />
                    </div>
                  </div>

                  {/* Regras dos links, logo abaixo do recurso, quando ele está ligado. */}
                  {item.key === "links" && ligado && pol && (
                    <div className="space-y-2 border-t border-(--separator-subtle) py-2.5 pl-[52px] pr-3">
                      <label className="flex items-center justify-between gap-3 text-[13px] text-(--text-primary)">
                        Exigir senha em todo link
                        <Switch checked={pol.require_password} disabled={!canEdit} label="Exigir senha em todo link"
                          onChange={() => salvarPolitica({ ...pol, require_password: !pol.require_password })} />
                      </label>
                      <div className="flex items-center justify-between gap-3">
                        <span id="rec-validade" className="text-[13px] text-(--text-primary)">Validade máxima dos links</span>
                        <Dropdown className="w-36" ariaLabelledby="rec-validade" value={pol.max_days ? String(pol.max_days) : ""} options={MAXIMOS}
                          onChange={(v) => { if (canEdit) salvarPolitica({ ...pol, max_days: v ? Number(v) : null }); }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {confirm && (
        <ConfirmModal
          title={`Desligar ${confirm.title.toLowerCase()}?`}
          description={confirm.offWarning}
          confirmLabel="Desligar"
          danger
          loading={busy === confirm.key}
          onConfirm={async () => { const item = confirm; await mudar(item, false); setConfirm(null); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
