import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ClipboardCheck, CalendarClock, FileWarning, Archive, Link2, CheckCircle2, RefreshCw, Building2, ChevronRight } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";

interface Resumo {
  obrigacoes_vencidas: number;
  obrigacoes_semana: number;
  obrigacoes_conferir: number;
  texto_com_falha: number;
  retencao_para_revisar: number;
  links_vencendo: number;
}
interface Obrigacao { id: string; name: string; period: string; period_label?: string; due_date: string; status: string; criticality: string; responsavel: string | null; dias_atraso: number }
interface Today { resumo: Resumo; modelos_obrigacao: number; obrigacoes: Obrigacao[]; texto_com_falha: { id: string; name: string; folder_id: string }[] }
interface GroupRow extends Resumo { company_id: string; name: string; total: number }

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;
const br = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });

/**
 * "O que fazer hoje" (achados A3-01, A3-24, A3-25): a primeira coisa do Início
 * é uma lista única de atenção, cada linha clicável e com o motivo; quando há
 * mais de uma empresa, a visão do grupo mostra onde está o problema.
 * Erro de carga mostra erro, nunca "tudo em dia" (A3-03).
 */
export default function TodayPanel() {
  const { current, companies, setCurrent, loading: companiesLoading } = useCompany();
  const navigate = useNavigate();
  const [data, setData] = useState<Today | null>(null);
  const [group, setGroup] = useState<GroupRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [verFalhas, setVerFalhas] = useState(false);
  const seq = useRef(0);

  // Só pede depois que a lista de empresas confirmou a empresa guardada: na
  // demo, o reset troca os ids e o id antigo do localStorage dava 404 (e o
  // painel ficava em erro). Respostas de pedidos antigos são ignoradas.
  const load = useCallback(() => {
    if (!current || companiesLoading) return;
    const n = ++seq.current;
    setFailed(false);
    setData(null);
    api.get<Today>(`/today/company/${current.id}`)
      .then((r) => { if (n === seq.current) setData(r.data); })
      .catch(() => { if (n === seq.current) setFailed(true); });
    if ((companies?.length ?? 0) > 1) {
      api.get<GroupRow[]>("/today/group")
        .then((r) => { if (n === seq.current) setGroup(r.data); })
        .catch(() => { if (n === seq.current) setGroup(null); });
    }
  }, [current?.id, companies?.length, companiesLoading]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);

  if (failed) {
    return (
      <section role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 flex flex-wrap items-center gap-3">
        <AlertTriangle className="w-5 h-5 text-(--text-warning)" aria-hidden />
        <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível montar a lista de hoje. Os dados continuam guardados.</p>
        <button onClick={load} className="inline-flex items-center gap-1.5 h-9 pointer-coarse:h-11 px-4 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover)">
          <RefreshCw className="w-3.5 h-3.5" aria-hidden /> Tentar de novo
        </button>
      </section>
    );
  }

  if (!data) {
    return <div className="h-[132px] rounded-(--radius-panel) bg-(--bg-hover) animate-pulse" aria-label="Carregando o que fazer hoje" />;
  }

  const r = data.resumo;
  const linhas: { key: string; icon: typeof CalendarClock; tone: string; texto: string; acao: string; to?: string }[] = [];
  if (r.obrigacoes_vencidas) linhas.push({ key: "venc", icon: AlertTriangle, tone: "text-(--text-danger)", texto: `${plural(r.obrigacoes_vencidas, "obrigação vencida", "obrigações vencidas")}`, acao: "Resolver", to: "/obligations?prazo=vencidas" });
  if (r.obrigacoes_semana) linhas.push({ key: "sem", icon: CalendarClock, tone: "text-(--text-warning)", texto: `${plural(r.obrigacoes_semana, "obrigação vence", "obrigações vencem")} nos próximos 7 dias`, acao: "Ver", to: "/obligations?prazo=semana" });
  if (r.obrigacoes_conferir) linhas.push({ key: "conf", icon: ClipboardCheck, tone: "text-(--text-accent)", texto: `${plural(r.obrigacoes_conferir, "documento espera conferência", "documentos esperam conferência")} em obrigações`, acao: "Conferir", to: "/obligations?status=reviewing" });
  if (r.texto_com_falha) {
    const um = data.texto_com_falha[0];
    linhas.push({
      key: "ocr", icon: FileWarning, tone: "text-(--text-warning)",
      texto: `${plural(r.texto_com_falha, "documento sem texto lido", "documentos sem texto lido")}: não aparecem na busca pelo conteúdo`,
      acao: r.texto_com_falha === 1 ? "Abrir" : verFalhas ? "Esconder" : "Ver quais",
      to: r.texto_com_falha === 1 && um ? `/documents?folder_id=${um.folder_id}&doc=${um.id}` : undefined,
    });
  }
  if (r.retencao_para_revisar) linhas.push({ key: "ret", icon: Archive, tone: "text-(--text-secondary)", texto: `${plural(r.retencao_para_revisar, "documento com retenção vencida", "documentos com retenção vencida")} esperando sua decisão`, acao: "Revisar", to: "/settings/retention" });
  if (r.links_vencendo) linhas.push({ key: "lnk", icon: Link2, tone: "text-(--text-secondary)", texto: `${plural(r.links_vencendo, "link compartilhado vence", "links compartilhados vencem")} em até 3 dias`, acao: "Ver links", to: "/shares" });

  const outras = (group ?? []).filter((g) => g.company_id !== current?.id && g.total > 0);

  return (
    <section aria-labelledby="hoje-titulo" className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="hoje-titulo" className="text-mac-title3 text-(--text-primary)">Para hoje</h2>
        <p className="text-mac-caption text-(--text-secondary)">{new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}</p>
      </div>
      {linhas.length === 0 ? (
        <p className="flex items-center gap-2 text-mac-body text-(--text-primary)"><CheckCircle2 className="w-4 h-4 text-(--text-success)" aria-hidden /> Tudo em dia em {current?.name}: nenhuma obrigação atrasada ou vencendo nesta semana.</p>
      ) : (
        <ul className="divide-y divide-(--border-default)">
          {linhas.map((l) => {
            const cls = "group w-full text-left flex items-center gap-3 min-h-11 py-1.5 rounded-(--radius-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) px-1";
            const inner = (
              <>
                <l.icon className={`w-4 h-4 shrink-0 ${l.tone}`} aria-hidden />
                <span className="flex-1">{l.texto}</span>
                <span className="text-mac-caption font-medium text-(--text-accent) group-hover:underline">{l.acao}</span>
                <ChevronRight className={`w-3.5 h-3.5 text-(--text-secondary) transition-transform duration-fast ${!l.to && verFalhas ? "rotate-90" : ""}`} aria-hidden />
              </>
            );
            return (
              <li key={l.key}>
                {l.to ? (
                  <Link to={l.to} className={cls}>{inner}</Link>
                ) : (
                  <button onClick={() => setVerFalhas((v) => !v)} aria-expanded={verFalhas} className={cls}>{inner}</button>
                )}
                {!l.to && verFalhas && (
                  <ul className="pl-8 pb-2 space-y-0.5">
                    {data.texto_com_falha.map((d) => (
                      <li key={d.id}>
                        <Link to={`/documents?folder_id=${d.folder_id}&doc=${d.id}`} className="block truncate min-h-8 py-1 text-mac-caption text-(--text-accent) hover:underline">{d.name}</Link>
                      </li>
                    ))}
                    {r.texto_com_falha > data.texto_com_falha.length && (
                      <li className="text-mac-caption text-(--text-secondary)">e mais {r.texto_com_falha - data.texto_com_falha.length}</li>
                    )}
                    <li className="text-mac-caption text-(--text-secondary)">Abra o documento e use “Ler o texto de novo” no painel de detalhes.</li>
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data.modelos_obrigacao === 0 && (
        <p className="text-mac-caption text-(--text-secondary)">
          Esta empresa ainda não tem obrigações cadastradas (guias, certidões, alvarás).{" "}
          <Link to="/obligations" className="font-medium text-(--text-accent) hover:underline">Cadastrar obrigações</Link>{" "}
          para acompanhar os prazos aqui.
        </p>
      )}
      {data.obrigacoes.length > 0 && (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2" aria-label="Obrigações mais urgentes">
          {data.obrigacoes.slice(0, 6).map((o) => (
            <li key={o.id}>
              <button onClick={() => navigate(`/obligations?instancia=${o.id}`)} className="w-full min-h-11 text-left rounded-(--radius-control) border border-(--border-default) px-3 py-2 hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
                <p className="text-mac-body text-(--text-primary) truncate">{o.name} <span className="text-(--text-secondary)">· {o.period_label ?? o.period}</span></p>
                <p className={`text-mac-caption ${o.dias_atraso > 0 ? "text-(--text-danger)" : "text-(--text-secondary)"}`}>
                  {o.dias_atraso > 0 ? `Venceu há ${plural(o.dias_atraso, "dia", "dias")} (${br(o.due_date)})` : o.dias_atraso === 0 ? "Vence hoje" : `Vence em ${br(o.due_date)}`}
                  {o.responsavel ? ` · ${o.responsavel}` : " · sem responsável"}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(() => {
        const total = r.obrigacoes_vencidas + r.obrigacoes_semana;
        const shown = Math.min(6, data.obrigacoes.length);
        return total > shown ? (
          <Link to="/obligations?prazo=semana" className="inline-flex items-center gap-1 text-mac-caption font-medium text-(--text-accent) hover:underline">
            e mais {total - shown} {total - shown === 1 ? "obrigação" : "obrigações"} <ChevronRight className="w-3 h-3" aria-hidden />
          </Link>
        ) : null;
      })()}
      {outras.length > 0 && (
        <div className="border-t border-(--border-default) pt-3">
          <h3 className="text-[11px] font-bold text-(--text-secondary) mb-2">No grupo</h3>
          <ul className="flex flex-wrap gap-2">
            {outras.map((g) => (
              <li key={g.company_id}>
                <button
                  onClick={() => { const c = companies.find((x) => x.id === g.company_id); if (c) setCurrent(c); }}
                  className="inline-flex items-center gap-1.5 h-9 pointer-coarse:h-11 px-3 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover)"
                  aria-label={`${g.name}: ${g.total} pendências. Trocar para esta empresa`}
                >
                  <Building2 className="w-3.5 h-3.5 text-(--text-secondary)" aria-hidden />
                  {g.name}
                  <span className={`ml-0.5 rounded-full px-1.5 text-mac-caption font-semibold ${g.obrigacoes_vencidas ? "bg-red-600 text-white" : "bg-amber-500/20 text-(--text-primary)"}`}>{g.total}</span>
                  {g.obrigacoes_vencidas > 0 && <span className="sr-only">, {g.obrigacoes_vencidas} vencidas</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
