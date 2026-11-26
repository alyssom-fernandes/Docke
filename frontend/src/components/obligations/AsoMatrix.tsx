import { useEffect, useState } from "react";
import { Plus, Stethoscope, UserX, Trash2 } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Dropdown from "@/components/ui/Dropdown";
import Checkbox from "@/components/ui/Checkbox";
import { fmtDate } from "./shared";

/*
 * Obrigação por colaborador: exames ocupacionais (ASO) e a matriz
 * colaborador × exame (FA-A7-05). Dado de saúde: só o admin da empresa vê.
 * A periodicidade do exame periódico vem do PCMSO da empresa (padrão 12 meses).
 */

type Estado = "ok" | "vence_logo" | "atrasado" | "pendente" | "nao_se_aplica";
interface Cel { estado: Estado; data?: string; prazo?: string; ultimo?: string; motivo?: string }
interface Exame { id: string; kind: string; exam_date: string; result: string; document_id: string | null; document_name: string | null; folder_id: string | null }
interface Colab {
  id: string; name: string; registration: string | null; role_title: string | null; admission_date: string; termination_date: string | null;
  periodic_months: number; situacao: Record<"admissional" | "periodico" | "demissional", Cel>; exames: Exame[];
}

const KIND: Record<string, string> = { admissional: "Admissional", periodico: "Periódico", retorno: "Retorno ao trabalho", mudanca_risco: "Mudança de risco", demissional: "Demissional" };
const RESULT: Record<string, string> = { apto: "Apto", apto_restricao: "Apto com restrição", inapto: "Inapto" };
const TOM: Record<Estado, string> = {
  ok: "bg-emerald-500/12 text-(--text-success)", vence_logo: "bg-amber-500/15 text-(--text-warning)", atrasado: "bg-red-500/12 text-(--text-danger)",
  pendente: "bg-(--bg-hover) text-(--text-secondary)", nao_se_aplica: "text-(--text-tertiary)",
};
const erro = (e: any, p: string) => (typeof e?.response?.data?.detail === "string" ? e.response.data.detail : p);

function Celula({ c }: { c: Cel }) {
  const texto = c.estado === "ok" ? (c.prazo ? `Até ${fmtDate(c.prazo)}` : `Feito em ${fmtDate(c.data!)}`)
    : c.estado === "vence_logo" ? `Vence ${fmtDate(c.prazo!)}`
    : c.estado === "atrasado" ? `Atrasado desde ${fmtDate(c.prazo!)}`
    : c.estado === "pendente" ? (c.prazo ? `Até ${fmtDate(c.prazo)}` : c.motivo ? `Pendente (${c.motivo})` : "Pendente")
    : "—";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-mac-caption whitespace-nowrap ${TOM[c.estado]}`}>{texto}</span>;
}

function NovoColaborador({ companyId, onClose, onDone }: { companyId: string; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [f, setF] = useState({ name: "", role_title: "", registration: "", admission_date: "", periodic_months: "12" });
  const [busy, setBusy] = useState(false);
  async function salvar() {
    setBusy(true);
    try {
      await api.post(`/companies/${companyId}/employees`, { ...f, periodic_months: Number(f.periodic_months) || 12, role_title: f.role_title || null, registration: f.registration || null });
      success(`${f.name} cadastrado.`); onDone(); onClose();
    } catch (e) { showError(erro(e, "Não foi possível cadastrar.")); } finally { setBusy(false); }
  }
  return (
    <Dialog onClose={onClose} size="sm" busy={busy} title="Novo colaborador" description="Para acompanhar os exames ocupacionais (ASO)."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={f.name.trim().length < 2 || !f.admission_date} onClick={salvar}>Cadastrar</Button></>}>
      <div className="space-y-3">
        <Input label="Nome" value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Função (opcional)" value={f.role_title} maxLength={120} onChange={(e) => setF({ ...f, role_title: e.target.value })} />
          <Input label="Matrícula (opcional)" value={f.registration} maxLength={40} onChange={(e) => setF({ ...f, registration: e.target.value })} />
          <Input label="Admissão" type="date" value={f.admission_date} onChange={(e) => setF({ ...f, admission_date: e.target.value })} />
          <Input label="Periódico a cada (meses)" type="number" min={1} max={60} value={f.periodic_months} onChange={(e) => setF({ ...f, periodic_months: e.target.value })} />
        </div>
        <p className="text-mac-caption text-(--text-secondary)">A periodicidade segue o PCMSO da empresa.</p>
      </div>
    </Dialog>
  );
}

function Detalhe({ c, companyId, onClose, onDone }: { c: Colab; companyId: string; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [x, setX] = useState({ kind: c.situacao.admissional.estado === "ok" ? "periodico" : "admissional", exam_date: new Date().toISOString().slice(0, 10), result: "apto", document_id: "" });
  const [deslig, setDeslig] = useState(c.termination_date ?? "");
  const [asos, setAsos] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // ASO digitalizado: documentos que citam o nome do colaborador (busca rápida da empresa).

    api.get("/search/quick", { params: { q: c.name, company_id: companyId } }).then((r) => setAsos((r.data ?? []).slice(0, 20))).catch(() => setAsos([]));
  }, [c.name, companyId]);
  async function registrar() {
    setBusy(true);
    try {
      await api.post(`/employees/${c.id}/exams`, { ...x, document_id: x.document_id || null });
      success(`${KIND[x.kind]} registrado.`); onDone(); onClose();
    } catch (e) { showError(erro(e, "Não foi possível registrar o exame.")); } finally { setBusy(false); }
  }
  async function salvarDeslig(limpar = false) {
    setBusy(true);
    try {
      await api.patch(`/employees/${c.id}`, limpar ? { limpar_desligamento: true } : { termination_date: deslig });
      success(limpar ? "Desligamento desfeito." : "Desligamento registrado: o demissional entra na lista."); onDone(); onClose();
    } catch (e) { showError(erro(e, "Não foi possível salvar.")); } finally { setBusy(false); }
  }
  async function apagarExame(id: string) {
    try { await api.delete(`/employee-exams/${id}`); success("Exame apagado."); onDone(); onClose(); } catch (e) { showError(erro(e, "Não foi possível apagar.")); }
  }
  return (
    <Dialog onClose={onClose} size="md" busy={busy} title={c.name}
      description={`${c.role_title ?? "Sem função informada"} · admissão ${fmtDate(c.admission_date)} · periódico a cada ${c.periodic_months} meses`}
      footer={<Button variant="secondary" onClick={onClose}>Fechar</Button>}>
      <div className="space-y-4">
        <fieldset className="rounded-(--radius-control) border border-(--border-default) p-3 space-y-3">
          <legend className="px-1 text-mac-body font-medium text-(--text-secondary)">Registrar exame</legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div><span id="aso-kind" className="block mb-1 text-mac-caption font-medium text-(--text-secondary)">Exame</span>
              <Dropdown ariaLabelledby="aso-kind" value={x.kind} onChange={(v) => setX({ ...x, kind: v })} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} /></div>
            <Input label="Data" type="date" value={x.exam_date} onChange={(e) => setX({ ...x, exam_date: e.target.value })} />
            <div><span id="aso-res" className="block mb-1 text-mac-caption font-medium text-(--text-secondary)">Resultado</span>
              <Dropdown ariaLabelledby="aso-res" value={x.result} onChange={(v) => setX({ ...x, result: v })} options={Object.entries(RESULT).map(([value, label]) => ({ value, label }))} /></div>
          </div>
          <div><span id="aso-doc" className="block mb-1 text-mac-caption font-medium text-(--text-secondary)">ASO digitalizado (opcional)</span>
            <Dropdown ariaLabelledby="aso-doc" value={x.document_id} onChange={(v) => setX({ ...x, document_id: v })}
              options={[{ value: "", label: asos.length ? "Nenhum" : "Nenhum documento com o nome encontrado" }, ...asos.map((d) => ({ value: d.id, label: d.name }))]} /></div>
          <Button size="sm" loading={busy} disabled={!x.exam_date} onClick={registrar}><Stethoscope className="w-3.5 h-3.5" aria-hidden />Registrar</Button>
        </fieldset>
        <div>
          <p className="mb-1 text-mac-body font-medium text-(--text-secondary)">Histórico</p>
          {c.exames.length === 0 ? <p className="text-mac-caption text-(--text-tertiary)">Nenhum exame registrado.</p> : (
            <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
              {c.exames.map((e) => (
                <li key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-mac-caption">
                  <span className="flex-1 text-(--text-primary)">{KIND[e.kind]} · {fmtDate(e.exam_date)} · {RESULT[e.result]}{e.document_name ? ` · ${e.document_name}` : ""}</span>
                  <button type="button" onClick={() => apagarExame(e.id)} aria-label={`Apagar exame ${KIND[e.kind]} de ${fmtDate(e.exam_date)}`}
                    className="h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><Trash2 className="w-3.5 h-3.5" aria-hidden /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[12rem]"><Input label="Desligamento" type="date" value={deslig} onChange={(e) => setDeslig(e.target.value)} /></div>
          <Button variant="secondary" disabled={busy || !deslig || deslig === c.termination_date} onClick={() => salvarDeslig()}><UserX className="w-3.5 h-3.5" aria-hidden />Registrar desligamento</Button>
          {c.termination_date && <Button variant="ghost" disabled={busy} onClick={() => salvarDeslig(true)}>Desfazer</Button>}
        </div>
      </div>
    </Dialog>
  );
}

export default function AsoMatrix({ companyId }: { companyId: string }) {
  const [dados, setDados] = useState<{ colaboradores: Colab[]; resumo: Record<string, number> } | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [novo, setNovo] = useState(false);
  const [aberto, setAberto] = useState<Colab | null>(null);
  const [desligados, setDesligados] = useState(false);
  function carregar() {
    setFalhou(false);
    api.get(`/companies/${companyId}/employees`, { params: { incluir_desligados: desligados } }).then((r) => setDados(r.data)).catch(() => setFalhou(true));
  }
  useEffect(carregar, [companyId, desligados]); // eslint-disable-line react-hooks/exhaustive-deps

  if (falhou) return <div role="alert" className="glass-panel rounded-(--radius-panel) p-5 flex items-center gap-3"><p className="flex-1 text-mac-body">Não foi possível carregar os exames.</p><Button variant="secondary" size="sm" onClick={carregar}>Tentar de novo</Button></div>;
  if (!dados) return <div className="h-40 animate-pulse rounded-(--radius-panel) bg-(--bg-card)" />;
  const r = dados.resumo;
  return (
    <section className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 space-y-3" aria-labelledby="aso-titulo">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="aso-titulo" className="flex-1 flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><Stethoscope className="w-4 h-4 text-(--text-accent)" aria-hidden />Exames ocupacionais (ASO)</h2>
        <label className="flex items-center gap-2 text-mac-caption text-(--text-secondary) cursor-pointer"><Checkbox checked={desligados} onChange={(e) => setDesligados(e.target.checked)} />Mostrar desligados antigos</label>
        <Button size="sm" onClick={() => setNovo(true)}><Plus className="w-3.5 h-3.5" aria-hidden />Colaborador</Button>
      </div>
      <p className="text-mac-caption text-(--text-secondary)" role="status">
        {r.atrasado} atrasado{r.atrasado === 1 ? "" : "s"} · {r.vence_logo} vence{r.vence_logo === 1 ? "" : "m"} em até 30 dias · {r.pendente} pendente{r.pendente === 1 ? "" : "s"}. Dado de saúde: só administradores da empresa veem esta lista.
      </p>
      {dados.colaboradores.length === 0 ? <p className="text-mac-body text-(--text-tertiary)">Nenhum colaborador cadastrado.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead><tr className="text-mac-caption text-(--text-secondary)">
              <th scope="col" className="px-2 py-1.5 font-normal">Colaborador</th>
              <th scope="col" className="px-2 py-1.5 font-normal">Admissional</th>
              <th scope="col" className="px-2 py-1.5 font-normal">Periódico</th>
              <th scope="col" className="px-2 py-1.5 font-normal">Demissional</th>
            </tr></thead>
            <tbody>
              {dados.colaboradores.map((c) => (
                <tr key={c.id} className="border-t border-(--border-default)">
                  <th scope="row" className="px-2 py-1.5 font-normal">
                    <button type="button" onClick={() => setAberto(c)} className="text-left hover:underline focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) rounded-sm">
                      <span className="block text-mac-body text-(--text-primary)">{c.name}</span>
                      <span className="block text-mac-caption text-(--text-secondary)">{c.role_title ?? "—"}{c.termination_date ? ` · desligado em ${fmtDate(c.termination_date)}` : ""}</span>
                    </button>
                  </th>
                  <td className="px-2 py-1.5"><Celula c={c.situacao.admissional} /></td>
                  <td className="px-2 py-1.5"><Celula c={c.situacao.periodico} /></td>
                  <td className="px-2 py-1.5"><Celula c={c.situacao.demissional} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {novo && <NovoColaborador companyId={companyId} onClose={() => setNovo(false)} onDone={carregar} />}
      {aberto && <Detalhe c={aberto} companyId={companyId} onClose={() => setAberto(null)} onDone={carregar} />}
    </section>
  );
}
