import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Dropdown from "@/components/ui/Dropdown";
import { type Member, scheduleText, CRIT_LABEL, friendly } from "./shared";

interface CatalogItem {
  key: string;
  segmentos: string[];
  name: string;
  description: string;
  legal_basis?: string;
  frequency: "mensal" | "anual" | "unica" | "evento";
  criticality: string;
  department?: string;
  due_day?: number;
  due_month?: number;
  due_month_offset?: number;
  validity_months?: number;
  ja_existe: boolean;
}

/**
 * Modelos prontos (A7-36): o gestor escolhe o segmento, marca o que vale para
 * a empresa e cria tudo de uma vez, já com as competências abertas. Prazos e
 * validades são sugestões: o aviso pede para conferir com a contabilidade.
 */
export default function CatalogDialog({ companyId, companyName, members, onClose, onApplied }: {
  companyId: string; companyName: string; members: Member[]; onClose: () => void; onApplied: () => void;
}) {
  const { success, error: showError } = useToast();
  const [data, setData] = useState<{ segmentos: { id: string; label: string }[]; itens: CatalogItem[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [segmento, setSegmento] = useState("geral");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    setFailed(false);
    api.get(`/companies/${companyId}/obligations/catalog`).then((r) => setData(r.data)).catch(() => setFailed(true));
  }
  useEffect(load, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const itens = useMemo(() => (data?.itens ?? []).filter((i) => i.segmentos.includes(segmento)), [data, segmento]);
  const novosNoSegmento = itens.filter((i) => !i.ja_existe);

  function toggle(key: string) {
    setChosen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }

  async function apply() {
    setSaving(true);
    try {
      const r = await api.post(`/companies/${companyId}/obligations/catalog`, { keys: [...chosen], default_owner_id: owner || null });
      success(`${r.data.created} ${r.data.created === 1 ? "obrigação cadastrada" : "obrigações cadastradas"}, ${r.data.generated} ${r.data.generated === 1 ? "competência aberta" : "competências abertas"}.`);
      onApplied();
    } catch (e) {
      showError(friendly(e, "Não foi possível cadastrar os modelos."));
    } finally {
      setSaving(false);
    }
  }

  const people = [...new Map(members.filter((m) => !m.folder_id && m.role !== "visualizador").map((m) => [m.user_id, m])).values()];

  return (
    <Dialog
      onClose={onClose}
      title="Modelos prontos"
      description={`Marque o que ${companyName} precisa cumprir. Tudo pode ser editado depois.`}
      size="xl"
      busy={saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button loading={saving} disabled={chosen.size === 0} onClick={apply}>
            {chosen.size === 0 ? "Marque ao menos um" : `Cadastrar ${chosen.size}`}
          </Button>
        </>
      }
    >
      <p className="mb-4 flex items-start gap-2 rounded-(--radius-control) bg-amber-500/10 px-3 py-2 text-mac-caption text-(--text-primary)">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-(--text-warning)" aria-hidden="true" />
        Prazos e validades são sugestões e mudam por estado, município e regime. Confira com a contabilidade antes de confiar nos avisos.
      </p>
      {failed ? (
        <div role="alert" className="flex items-center gap-3">
          <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar os modelos.</p>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
        </div>
      ) : !data ? (
        <div className="space-y-2" aria-label="Carregando">{[0, 1, 2, 3].map((i) => <div key={i} className="h-12 rounded bg-(--bg-hover) animate-pulse" />)}</div>
      ) : (
        <div className="space-y-4">
          <div role="tablist" aria-label="Segmento" className="flex flex-wrap gap-1.5">
            {data.segmentos.map((s) => (
              <button key={s.id} role="tab" aria-selected={segmento === s.id} onClick={() => setSegmento(s.id)}
                className={`px-3 h-8 pointer-coarse:h-10 rounded-full text-mac-body font-medium border transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${segmento === s.id ? "bg-teal-600 text-white border-teal-600" : "border-(--border-control) text-(--text-primary) hover:bg-(--bg-hover)"}`}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-mac-caption text-(--text-secondary)">{itens.length} modelos · {itens.length - novosNoSegmento.length} já cadastrados</p>
            {novosNoSegmento.length > 0 && (
              <button className="text-mac-caption font-medium text-(--text-accent) hover:underline"
                onClick={() => setChosen((s) => { const n = new Set(s); novosNoSegmento.forEach((i) => n.add(i.key)); return n; })}>
                Marcar todos deste segmento
              </button>
            )}
          </div>
          <ul role="tabpanel" className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
            {itens.map((i) => (
              <li key={i.key}>
                <label className={`flex items-start gap-3 px-3 py-2.5 ${i.ja_existe ? "opacity-60" : "cursor-pointer hover:bg-(--bg-hover)"}`}>
                  <Checkbox checked={i.ja_existe || chosen.has(i.key)} disabled={i.ja_existe} onChange={() => toggle(i.key)} className="mt-1" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-mac-body font-medium text-(--text-primary)">{i.name}{i.ja_existe && <span className="font-normal text-(--text-secondary)"> · já cadastrada</span>}</span>
                    <span className="block text-mac-caption text-(--text-secondary)">{i.description}</span>
                    <span className="block text-mac-caption text-(--text-secondary)">
                      {scheduleText({ frequency: i.frequency, due_day: i.due_day ?? null, due_month: i.due_month ?? null, due_month_offset: i.due_month_offset ?? 1, validity_months: i.validity_months ?? null })}
                      {" · "}criticidade {CRIT_LABEL[i.criticality]?.toLowerCase()}{i.department ? ` · ${i.department}` : ""}{i.legal_basis ? ` · ${i.legal_basis}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="sm:w-80">
            <label id="cat-owner" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Quem cuida destas obrigações</label>
            <Dropdown ariaLabelledby="cat-owner" value={owner} onChange={setOwner} placeholder="Ninguém por enquanto"
              options={[{ value: "", label: "Ninguém por enquanto" }, ...people.map((m) => ({ value: m.user_id, label: m.full_name }))]} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
