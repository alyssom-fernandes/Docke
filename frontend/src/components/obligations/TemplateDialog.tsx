import { useId, useState } from "react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";
import Dropdown from "@/components/ui/Dropdown";
import { type Template, type Member, MESES, FREQ_LABEL, CRIT_LABEL, friendly } from "./shared";

const CONDITIONAL_FIELD_LABEL: Record<string, string> = {
  regime_tributario: "Regime tributário",
  faixa_funcionarios: "Quantidade de funcionários",
  uf: "UF",
  tipo_juridico: "Tipo jurídico",
};
const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];
const CONDITIONAL_VALUE_OPTIONS: Record<string, { value: string; label: string }[]> = {
  regime_tributario: [
    { value: "simples_nacional", label: "Simples Nacional" },
    { value: "lucro_presumido", label: "Lucro Presumido" },
    { value: "lucro_real", label: "Lucro Real" },
  ],
  faixa_funcionarios: [
    { value: "nenhum", label: "Nenhum funcionário" },
    { value: "1_a_10", label: "1 a 10" },
    { value: "11_a_50", label: "11 a 50" },
    { value: "51_a_200", label: "51 a 200" },
    { value: "201_mais", label: "201 ou mais" },
  ],
  tipo_juridico: [
    { value: "mei", label: "MEI" }, { value: "ltda", label: "LTDA" }, { value: "sa", label: "S.A." },
    { value: "eireli", label: "EIRELI" }, { value: "outro", label: "Outro" },
  ],
  uf: UFS.map((u) => ({ value: u, label: u })),
};

const CRIT_HINT: Record<string, string> = {
  baixa: "Só aparece na lista.",
  media: "Aparece no Início quando vence.",
  alta: "Avisa o responsável e o admin quando atrasa.",
  critica: "Destaque vermelho e conta em “críticas pendentes”.",
};

const FREQ_HINT: Record<string, string> = {
  mensal: "Uma competência por mês, aberta sozinha antes do vencimento.",
  anual: "Uma competência por ano, aberta sozinha antes do vencimento.",
  unica: "Licenças e certidões: o documento tem validade e o Docke avisa antes de vencer.",
  evento: "Abra uma competência a cada ocorrência (ex.: coleta de óleo, admissão).",
};

function parseRules(t?: Template) {
  const r = typeof t?.rules_json === "string" ? JSON.parse(t.rules_json || "{}") : t?.rules_json ?? {};
  return r?.not_applicable_when as { field: string; in: string[] } | undefined;
}

/** Cadastro e edição com os primitivos do projeto (A7-04, A7-39), vencimento e responsável padrão (A7-38). */
export default function TemplateDialog({ companyId, template, members, onClose, onSaved }: {
  companyId: string; template?: Template; members: Member[]; onClose: () => void; onSaved: (generated: number) => void;
}) {
  const { success, error: showError } = useToast();
  const uid = useId();
  const cond = parseRules(template);
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [department, setDepartment] = useState(template?.department ?? "");
  const [frequency, setFrequency] = useState<string>(template?.frequency ?? "mensal");
  const [criticality, setCriticality] = useState<string>(template?.criticality ?? "media");
  const [dueDay, setDueDay] = useState(template?.due_day ? String(template.due_day) : "");
  const [offset, setOffset] = useState(String(template?.due_month_offset ?? 1));
  const [dueMonth, setDueMonth] = useState(template?.due_month ? String(template.due_month) : "");
  const [slaDays, setSlaDays] = useState(String(template?.sla_days ?? 7));
  const [validity, setValidity] = useState(template?.validity_months ? String(template.validity_months) : "");
  const [owner, setOwner] = useState(template?.default_owner_id ?? "");
  const [review, setReview] = useState(template?.requires_review ?? true);
  const [legal, setLegal] = useState(template?.legal_basis ?? "");
  const [condOn, setCondOn] = useState(!!cond);
  const [condField, setCondField] = useState(cond?.field ?? "regime_tributario");
  const [condValues, setCondValues] = useState<string[]>(cond?.in ?? []);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = "Dê um nome (ex.: Alvará de funcionamento).";
  const dd = Number(dueDay);
  if (dueDay && (!Number.isInteger(dd) || dd < 1 || dd > 31)) errors.dueDay = "Dia entre 1 e 31.";
  if (frequency === "anual" && dueDay && !dueMonth) errors.dueMonth = "Escolha o mês.";
  const sla = Number(slaDays);
  if (slaDays === "" || !Number.isInteger(sla) || sla < 0 || sla > 365) errors.sla = "De 0 a 365 dias.";
  const val = Number(validity);
  if (validity && (!Number.isInteger(val) || val < 1 || val > 240)) errors.validity = "De 1 a 240 meses.";
  if (condOn && condValues.length === 0) errors.cond = "Escolha ao menos um valor.";
  const invalid = Object.keys(errors).length > 0;

  async function submit() {
    setTouched(true);
    if (invalid) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      name: name.trim(), description: description.trim() || null, department: department.trim() || null,
      frequency, criticality, sla_days: sla, due_day: dueDay ? dd : null,
      due_month_offset: frequency === "mensal" ? Number(offset) : 1, due_month: frequency === "anual" && dueMonth ? Number(dueMonth) : null,
      validity_months: validity ? val : null, default_owner_id: owner || null, requires_review: review, legal_basis: legal.trim() || null,
      rules_json: condOn ? { not_applicable_when: { field: condField, in: condValues } } : {},
    };
    try {
      const r = template
        ? await api.patch(`/obligations/templates/${template.id}`, { ...body, clear_validity_months: !validity })
        : await api.post(`/companies/${companyId}/obligations/templates`, { ...body, company_id: companyId });
      success(template ? "Obrigação atualizada." : "Obrigação cadastrada.");
      onSaved(r.data?.generated ?? 0);
    } catch (e) {
      showError(friendly(e, "Não foi possível salvar. Confira os campos."));
    } finally {
      setSaving(false);
    }
  }

  const people = [...new Map(members.filter((m) => !m.folder_id && m.role !== "visualizador").map((m) => [m.user_id, m])).values()];
  const err = (k: string) => (touched ? errors[k] : undefined);
  const selectCls = "w-full";

  return (
    <Dialog
      onClose={onClose}
      title={template ? `Editar “${template.name}”` : "Nova obrigação"}
      description="O que a empresa precisa comprovar, de quanto em quanto tempo e quem cuida."
      size="lg"
      busy={saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button loading={saving} onClick={submit}>{template ? "Salvar" : "Cadastrar"}</Button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Ex.: Licença sanitária" error={err("name")} autoFocus />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-desc`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">O que comprova (opcional)</label>
          <textarea id={`${uid}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000}
            placeholder="Ex.: Alvará da Vigilância Sanitária. Prova: o alvará vigente."
            className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
        </div>

        <div>
          <label id={`${uid}-freq`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">Repete</label>
          <Dropdown ariaLabelledby={`${uid}-freq`} className={selectCls} value={frequency} onChange={setFrequency}
            options={Object.entries(FREQ_LABEL).map(([value, label]) => ({ value, label }))} />
          <p className="mt-1 text-mac-caption text-(--text-secondary)">{FREQ_HINT[frequency]}</p>
        </div>
        <div>
          <label id={`${uid}-crit`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">Criticidade</label>
          <Dropdown ariaLabelledby={`${uid}-crit`} className={selectCls} value={criticality} onChange={setCriticality}
            options={Object.entries(CRIT_LABEL).map(([value, label]) => ({ value, label }))} />
          <p className="mt-1 text-mac-caption text-(--text-secondary)">{CRIT_HINT[criticality]}</p>
        </div>

        {(frequency === "mensal" || frequency === "anual") && (
          <fieldset className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-4 rounded-(--radius-control) border border-(--border-default) p-3">
            <legend className="px-1 text-mac-caption font-semibold text-(--text-secondary)">Vencimento</legend>
            <Input label="Dia" inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="Ex.: 20" error={err("dueDay")} />
            {frequency === "mensal" ? (
              <div className="sm:col-span-2">
                <label id={`${uid}-off`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">De qual mês</label>
                <Dropdown ariaLabelledby={`${uid}-off`} value={offset} onChange={setOffset}
                  options={[{ value: "0", label: "Do próprio mês da competência" }, { value: "1", label: "Do mês seguinte (o mais comum)" }, { value: "2", label: "Dois meses depois" }, { value: "3", label: "Três meses depois" }]} />
              </div>
            ) : (
              <div className="sm:col-span-2">
                <label id={`${uid}-mes`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">Mês</label>
                <Dropdown ariaLabelledby={`${uid}-mes`} value={dueMonth} onChange={setDueMonth} placeholder="Escolha o mês"
                  options={MESES.map((m, i) => ({ value: String(i + 1), label: m[0].toUpperCase() + m.slice(1) }))} />
                {err("dueMonth") && <p className="mt-1 text-mac-caption text-(--text-danger)">{errors.dueMonth}</p>}
              </div>
            )}
            <p className="sm:col-span-3 text-mac-caption text-(--text-secondary)">
              {dueDay ? "As competências aparecem sozinhas até 45 dias antes de vencer." : "Sem o dia, cada competência precisa ser aberta à mão."} Dia 31 em mês mais curto vira o último dia.
            </p>
          </fieldset>
        )}

        <Input label="Avisar quantos dias antes" inputMode="numeric" value={slaDays} onChange={(e) => setSlaDays(e.target.value.replace(/\D/g, "").slice(0, 3))} error={err("sla")} />
        <Input label="Validade do documento (meses, opcional)" inputMode="numeric" value={validity} onChange={(e) => setValidity(e.target.value.replace(/\D/g, "").slice(0, 3))}
          placeholder="Ex.: 6 para certidão de 180 dias" error={err("validity")} />

        <div>
          <label id={`${uid}-own`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">Responsável padrão</label>
          <Dropdown ariaLabelledby={`${uid}-own`} value={owner} onChange={setOwner} placeholder="Ninguém (avisa admins e operadores)"
            options={[{ value: "", label: "Ninguém (avisa admins e operadores)" }, ...people.map((m) => ({ value: m.user_id, label: m.full_name }))]} />
        </div>
        <Input label="Departamento (opcional)" value={department} onChange={(e) => setDepartment(e.target.value)} maxLength={60} placeholder="Ex.: Fiscal, RH" />
        <div className="sm:col-span-2">
          <Input label="Base legal ou quem exige (opcional)" value={legal} onChange={(e) => setLegal(e.target.value)} maxLength={200} placeholder="Ex.: RDC Anvisa 216/2004" />
        </div>

        <label className="sm:col-span-2 flex items-start gap-3 cursor-pointer text-mac-body text-(--text-primary)">
          <Checkbox checked={review} onChange={(e) => setReview(e.target.checked)} className="mt-0.5" />
          <span>
            Conferir o documento antes de dar como cumprida
            <span className="block text-mac-caption text-(--text-secondary)">Recomendado para licenças e certidões: um documento errado não fecha a obrigação sozinho.</span>
          </span>
        </label>

        <div className="sm:col-span-2 space-y-3 rounded-(--radius-control) border border-(--border-default) p-3">
          <label className="flex items-start gap-3 cursor-pointer text-mac-body text-(--text-primary)">
            <Checkbox checked={condOn} onChange={(e) => setCondOn(e.target.checked)} className="mt-0.5" />
            <span>
              Não se aplica a algumas empresas
              <span className="block text-mac-caption text-(--text-secondary)">Usa o perfil fiscal cadastrado em Ajustes → Organização.</span>
            </span>
          </label>
          {condOn && (
            <>
              <div>
                <label id={`${uid}-cf`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Quando</label>
                <Dropdown ariaLabelledby={`${uid}-cf`} value={condField} onChange={(v) => { setCondField(v); setCondValues([]); }}
                  options={Object.entries(CONDITIONAL_FIELD_LABEL).map(([value, label]) => ({ value, label }))} />
              </div>
              <div role="group" aria-label="For um destes" className="flex flex-wrap gap-1.5">
                {(CONDITIONAL_VALUE_OPTIONS[condField] ?? []).map((opt) => {
                  const on = condValues.includes(opt.value);
                  return (
                    <button key={opt.value} type="button" aria-pressed={on}
                      onClick={() => setCondValues((p) => (on ? p.filter((v) => v !== opt.value) : [...p, opt.value]))}
                      className={`px-2.5 h-8 pointer-coarse:h-10 rounded-full text-mac-caption font-medium border transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${on ? "bg-(--accent) text-white border-(--accent)" : "border-(--border-control) text-(--text-primary) hover:bg-(--bg-hover)"}`}>
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {err("cond") && <p className="text-mac-caption text-(--text-danger)">{errors.cond}</p>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
