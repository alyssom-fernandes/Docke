import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, ShieldAlert, ChevronRight } from "lucide-react";
import api from "@/lib/api";
import { readView, writeView } from "@/lib/viewCache";

/**
 * Saúde da segurança da empresa (B4.2.5), no estilo do "Security health" do
 * Google Workspace: cada linha é uma recomendação com o número real e o
 * caminho para resolver. Tudo calculado a partir das listas que o admin já
 * vê (pessoas e links); nada é estimado.
 */
interface Pessoa { is_active: boolean; mfa_enabled?: boolean; last_sign_in_at: string | null; grants: { role: string }[]; via_groups: { role: string }[] }
interface Link { has_password?: boolean; revoked_at: string | null; expires_at: string | null; allow_download?: boolean; expired_at?: string | null }
interface Linha { ok: boolean; texto: string; to: string }

const DIA = 86_400_000;

export default function SecurityHealth({ companyId }: { companyId: string }) {
  const chave = `seguranca:${companyId}`;
  const [linhas, setLinhas] = useState<Linha[] | null>(() => readView<Linha[]>(chave) ?? null);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    let vivo = true;
    setFalhou(false);
    Promise.all([
      api.get<Pessoa[]>(`/companies/${companyId}/people`),
      api.get<Link[]>("/shares", { params: { company_id: companyId } }),
    ]).then(([p, s]) => {
      if (!vivo) return;
      const ativas = p.data.filter((x) => x.is_active);
      const admins = ativas.filter((x) => [...x.grants, ...x.via_groups].some((g) => g.role === "admin"));
      const adminsSem2 = admins.filter((x) => !x.mfa_enabled).length;
      const sem2 = ativas.filter((x) => !x.mfa_enabled).length;
      const paradas = ativas.filter((x) => !x.last_sign_in_at || Date.now() - new Date(x.last_sign_in_at).getTime() > 90 * DIA).length;
      const agora = Date.now();
      const ativos = s.data.filter((l) => !l.revoked_at && !l.expired_at && (!l.expires_at || new Date(l.expires_at).getTime() > agora));
      const semSenha = ativos.filter((l) => !l.has_password).length;
      const semPrazo = ativos.filter((l) => !l.expires_at).length;
      const r: Linha[] = [
        { ok: adminsSem2 === 0, texto: adminsSem2 ? `${adminsSem2} de ${admins.length} ${admins.length === 1 ? "administrador" : "administradores"} sem verificação em duas etapas` : `Todos os administradores (${admins.length}) usam verificação em duas etapas`, to: "/settings/users" },
        { ok: sem2 === 0, texto: sem2 ? `${sem2} de ${ativas.length} ${ativas.length === 1 ? "pessoa" : "pessoas"} sem verificação em duas etapas` : "Todas as pessoas usam verificação em duas etapas", to: "/settings/security" },
        { ok: paradas === 0, texto: paradas ? `${paradas} ${paradas === 1 ? "conta ativa não entra" : "contas ativas não entram"} há mais de 90 dias (ou nunca entraram)` : "Nenhuma conta ativa parada há mais de 90 dias", to: "/settings/users" },
        { ok: semSenha === 0, texto: semSenha ? `${semSenha} ${semSenha === 1 ? "link público ativo sem senha" : "links públicos ativos sem senha"}` : "Todo link público ativo pede senha", to: "/shares" },
        { ok: semPrazo === 0, texto: semPrazo ? `${semPrazo} ${semPrazo === 1 ? "link público ativo sem prazo" : "links públicos ativos sem prazo"} para acabar` : "Todo link público ativo tem prazo", to: "/shares" },
      ];
      setLinhas(writeView(chave, r));
    }).catch(() => { if (vivo) setFalhou(true); });
    return () => { vivo = false; };
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendentes = linhas?.filter((l) => !l.ok).length ?? 0;
  return (
    <section aria-labelledby="adm-seguranca" className="glass-panel glass-blur-card rounded-(--radius-panel) p-4 sm:p-5 space-y-2">
      <h2 id="adm-seguranca" className="flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)">
        {pendentes ? <ShieldAlert className="w-4 h-4 text-(--text-warning)" aria-hidden="true" /> : <ShieldCheck className="w-4 h-4 text-(--text-success)" aria-hidden="true" />}
        Saúde da segurança{linhas ? <span className="font-normal text-(--text-secondary)"> · {pendentes ? `${pendentes} ${pendentes === 1 ? "recomendação" : "recomendações"}` : "tudo em ordem"}</span> : null}
      </h2>
      {falhou && !linhas ? <p className="text-mac-caption text-(--text-secondary)">Não carregou agora. Abra de novo em instantes.</p>
        : !linhas ? <div className="h-16 rounded bg-(--bg-hover) animate-pulse" aria-label="Carregando" />
        : (
          <ul className="divide-y divide-(--border-default)">
            {linhas.map((l) => (
              <li key={l.texto}>
                <Link to={l.to} className="flex items-center gap-3 min-h-11 py-1.5 text-mac-body text-(--text-primary) hover:underline rounded-(--radius-control) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
                  <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${l.ok ? "bg-(--text-success)" : "bg-(--text-warning)"}`} />
                  <span className="flex-1">{l.texto}</span>
                  <span className="sr-only">{l.ok ? "em ordem" : "recomendação"}</span>
                  <ChevronRight className="w-4 h-4 text-(--text-secondary)" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
