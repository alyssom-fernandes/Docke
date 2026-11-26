import { useEffect, useState, FormEvent } from "react";
import { ShieldCheck, ShieldAlert, KeyRound, Laptop, Smartphone, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useCompany } from "@/lib/CompanyContext";
import { useAuthContext } from "@/lib/AuthContext";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import { rememberChoice } from "@/lib/session";
import { friendlyError } from "@/lib/errors";
import { relativeDate } from "@/lib/date";
import Dialog from "@/components/ui/Dialog";
import { MfaEnroll } from "@/components/shared/MfaSetup";

interface IntegrityResult {
  total_events: number;
  intact: boolean;
  broken_count: number;
  // event_id e event_created_at vêm nulos na quebra de "Cadeia truncada"
  // (eventos mais recentes apagados): não há evento para apontar.
  first_broken: { event_id: string | null; event_created_at: string | null; reason: string } | null;
}

// Cartão com cabeçalho padrão (A8-11): ícone, título e descrição.
function Cartao({ icon: Icon, cor, titulo, descricao, children, className = "" }: {
  icon: LucideIcon; cor: string; titulo: string; descricao?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <section className={`glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-6 ${className}`} aria-label={titulo}>
      <div className="flex items-start gap-3">
        <span className={`w-8 h-8 rounded-[9px] flex items-center justify-center shrink-0 ${cor}`} aria-hidden="true">
          <Icon className="w-4 h-4 text-white" strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <h2 className="text-mac-body font-semibold text-(--text-primary)">{titulo}</h2>
          {descricao && <p className="text-mac-caption text-(--text-secondary) mt-0.5">{descricao}</p>}
        </div>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}

interface Sessao { id: string; created_at: string; ultimo_uso: string; user_agent: string | null; ip: string | null; atual: boolean }

/** "Chrome no Windows", "Safari no iPhone"… a partir do user agent. */
function aparelho(ua: string | null): string {
  if (!ua) return "Aparelho desconhecido";
  const nav = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /python|httpx|curl/i.test(ua) ? "Programa" : "Navegador";
  const so = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return so ? `${nav} no ${so}` : nav;
}

// Sessões ativas com encerramento remoto (FA-A8-02, B4.2.6).
function SessionsSection() {
  const { success, error: showError } = useToast();
  const [data, setData] = useState<{ demo: boolean; sessions: Sessao[] } | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    setFalhou(false);
    api.get("/auth/sessions").then((r) => setData(r.data)).catch(() => setFalhou(true));
  }
  useEffect(load, []);

  async function encerrar(id: string | "outras") {
    setBusy(id);
    try {
      if (id === "outras") {
        const r = await api.post("/auth/sessions/end-others");
        success(r.data.encerradas ? `${r.data.encerradas} ${r.data.encerradas === 1 ? "sessão encerrada" : "sessões encerradas"}.` : "Não havia outras sessões.");
      } else {
        await api.delete(`/auth/sessions/${id}`);
        success("Sessão encerrada.");
      }
      load();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível encerrar agora."));
    } finally {
      setBusy(null);
    }
  }

  const outras = data?.sessions.filter((s) => !s.atual).length ?? 0;
  return (
    <Cartao icon={Laptop} cor="bg-sky-600" titulo="Onde sua conta está aberta"
      descricao="Computadores e celulares com sessão aberta. Encerre a que você não reconhece ou que ficou aberta em outro lugar.">
      {falhou ? (
        <div role="alert" className="flex items-center gap-3 text-mac-body text-(--text-secondary)">
          Não foi possível carregar. <Button size="sm" variant="secondary" onClick={load}>Tentar de novo</Button>
        </div>
      ) : !data ? (
        <div className="h-16 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />
      ) : data.demo ? (
        <p className="text-mac-body text-(--text-secondary) max-w-[520px]">A conta de demonstração é usada por vários visitantes ao mesmo tempo, então as sessões dela não aparecem aqui.</p>
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-(--border-default)">
            {data.sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-mac-body text-(--text-primary)">{aparelho(s.user_agent)}{s.atual && <span className="ml-2 text-mac-caption font-medium text-(--text-success)">esta sessão</span>}</p>
                  <p className="text-mac-caption text-(--text-secondary)">Usada {relativeDate(s.ultimo_uso)} · aberta em {new Date(s.created_at).toLocaleDateString("pt-BR")}{s.ip ? ` · IP ${s.ip}` : ""}</p>
                </div>
                {!s.atual && <Button size="sm" variant="secondary" loading={busy === s.id} disabled={!!busy} onClick={() => encerrar(s.id)}>Encerrar</Button>}
              </li>
            ))}
          </ul>
          {outras > 0 && <Button size="sm" variant="ghost" loading={busy === "outras"} disabled={!!busy} onClick={() => encerrar("outras")}>Encerrar todas as outras</Button>}
        </div>
      )}
    </Cartao>
  );
}

interface MfaInfo { ativada: boolean; exigida: boolean; demo: boolean; fatores: { id: string; nome: string; criado_em: string }[] }

// Verificação em duas etapas (decisão do dono, 26/11/2026).
function MfaSection() {
  const { completeMfa } = useAuthContext();
  const { success, error: showError } = useToast();
  const [info, setInfo] = useState<MfaInfo | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [cadastrando, setCadastrando] = useState(false);
  const [desligando, setDesligando] = useState(false);
  const [busy, setBusy] = useState(false);

  function load() {
    setFalhou(false);
    api.get<MfaInfo>("/auth/mfa").then((r) => setInfo(r.data)).catch(() => setFalhou(true));
  }
  useEffect(load, []);

  async function desligar() {
    if (!info?.fatores[0]) return;
    setBusy(true);
    try {
      await api.delete(`/auth/mfa/${info.fatores[0].id}`);
      success("Verificação em duas etapas desligada.");
      setDesligando(false);
      load();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível desligar agora."));
    } finally {
      setBusy(false);
    }
  }

  const desde = info?.fatores[0] ? new Date(info.fatores[0].criado_em).toLocaleDateString("pt-BR") : null;
  return (
    <Cartao icon={Smartphone} cor="bg-indigo-500" titulo="Verificação em duas etapas"
      descricao="Além da senha, um código de 6 números do app autenticador do celular. Quem descobrir a sua senha não entra sem o celular.">
      {falhou ? (
        <div role="alert" className="flex items-center gap-3 text-mac-body text-(--text-secondary)">
          Não foi possível ver a situação agora. <Button size="sm" variant="secondary" onClick={load}>Tentar de novo</Button>
        </div>
      ) : !info ? (
        <div className="h-10 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />
      ) : info.demo ? (
        <p className="text-mac-body text-(--text-secondary) max-w-[520px]">A conta de demonstração é compartilhada pelos visitantes e não usa verificação em duas etapas.</p>
      ) : info.ativada ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-mac-body text-(--text-primary)">
            <ShieldCheck className="w-4 h-4 text-(--text-success)" aria-hidden="true" /> Ativada{desde ? ` desde ${desde}` : ""}.
            {info.exigida && <span className="text-mac-caption text-(--text-secondary)">A sua empresa exige para o seu papel.</span>}
          </p>
          {!info.exigida && <Button size="sm" variant="secondary" onClick={() => setDesligando(true)}>Desligar</Button>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-mac-body text-(--text-secondary)">Desligada.</p>
          <Button size="sm" onClick={() => setCadastrando(true)}><ShieldCheck className="w-4 h-4" aria-hidden="true" /> Ativar</Button>
        </div>
      )}
      {cadastrando && (
        <Dialog onClose={() => setCadastrando(false)} title="Ativar a verificação em duas etapas" size="sm">
          <div className="@container">
            <MfaEnroll onDone={async (t) => { await completeMfa(t); setCadastrando(false); success("Verificação em duas etapas ativada."); load(); }} />
          </div>
        </Dialog>
      )}
      {desligando && (
        <Dialog onClose={() => setDesligando(false)} title="Desligar a verificação em duas etapas?" size="sm" busy={busy}
          description="A sua conta volta a pedir só a senha. Dá para ativar de novo quando quiser."
          footer={<><Button variant="ghost" onClick={() => setDesligando(false)}>Cancelar</Button><Button variant="danger" loading={busy} onClick={desligar}>Desligar</Button></>} />
      )}
    </Cartao>
  );
}

// Fase 2.9: botão "verificar integridade da cadeia" — só admin/supremo, é
// ferramenta de auditoria, não algo que todo membro da empresa precisa ver.
function IntegritySection() {
  const { current } = useCompany();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<IntegrityResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    if (!current) return;
    setChecking(true);
    setError(null);
    try {
      const r = await api.get<IntegrityResult>("/activity/verify-integrity", { params: { company_id: current.id } });
      setResult(r.data);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Não foi possível verificar a integridade agora.");
    } finally {
      setChecking(false);
    }
  }

  if (!current || (current.permission_level !== "admin" && current.permission_level !== "supremo")) return null;

  return (
    <Cartao icon={ShieldCheck} cor="bg-teal-600" titulo="Integridade da trilha de auditoria" className="mt-4"
      descricao="Cada evento registrado em Atividade carrega um hash encadeado ao anterior. Um evento alterado fora do fluxo normal aparece como adulterado, e um evento apagado quebra a cadeia a partir dele, inclusive quando é o mais recente.">
      <Button size="sm" variant="secondary" onClick={verify} loading={checking}>
        Verificar agora
      </Button>
      {result && (
        <div role="status" key={`${result.total_events}-${result.broken_count}`} className={`reveal mt-4 flex items-start gap-2 p-3 rounded-(--radius-control) ${result.intact ? "bg-emerald-500/10" : "bg-red-500/10"}`}>
          {result.intact ? (
            <ShieldCheck className="w-4 h-4 text-(--text-success) shrink-0 mt-0.5" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-(--text-danger) shrink-0 mt-0.5" />
          )}
          <div className="text-mac-caption">
            {result.intact ? (
              <p className="text-(--text-primary)">Cadeia íntegra — {result.total_events} eventos verificados, nenhuma quebra encontrada.</p>
            ) : (
              <p className="text-(--text-danger)">
                Quebra detectada em {result.broken_count} ponto{result.broken_count > 1 ? "s" : ""}. {result.first_broken?.reason}
                {result.first_broken?.event_created_at && (
                  <> O primeiro evento afetado foi registrado originalmente em {new Date(result.first_broken.event_created_at).toLocaleString("pt-BR")}.</>
                )}
              </p>
            )}
          </div>
        </div>
      )}
      {error && <p role="alert" className="reveal text-mac-caption text-(--text-danger) mt-3">{error}</p>}
    </Cartao>
  );
}

export default function Security() {
  usePageTitle("Segurança");
  const { user } = useAuthContext();
  // Conta demo é compartilhada: o backend recusa a troca de senha dela.
  const isDemo = user?.username === "demo";
  const { success, error: showError } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; new?: string; confirm?: string }>({});
  const [show, setShow] = useState(false);
  // Força da senha (A8-10): requisitos visíveis antes de enviar, não só no erro.
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(newPassword)).length;
  const forca = !newPassword ? 0 : newPassword.length < 8 ? 1 : newPassword.length >= 12 && classes >= 3 ? 3 : classes >= 2 ? 2 : 1;
  const forcaTexto = ["", "Fraca", "Razoável", "Forte"][forca];

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

  const lembra = rememberChoice();
  return (
    <div className="space-y-4">
      {/* Resumo no topo (A8-11): como esta sessão se comporta neste computador. */}
      <Cartao icon={Laptop} cor="bg-slate-500" titulo="Esta sessão"
        descricao={lembra
          ? "Fica conectada neste computador mesmo depois de fechar o navegador. Em computador compartilhado, saia pelo menu da conta ao terminar."
          : "Termina quando a janela do navegador é fechada (bom para computador compartilhado)."} />
      <Cartao icon={KeyRound} cor="bg-red-500" titulo="Senha" descricao="Troque a senha da sua conta. Ela vale para todas as empresas que você acessa.">
        {isDemo ? (
          <p className="text-mac-body text-(--text-secondary) max-w-[520px]">
            Na conta de demonstração a senha não pode ser trocada, porque todos os visitantes usam a mesma conta.
          </p>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4 max-w-[400px]">
          <Input
            label="Senha atual"
            type={show ? "text" : "password"}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            error={errors.current}
            autoComplete="current-password"
          />
          <Input
            label="Nova senha"
            type={show ? "text" : "password"}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={errors.new}
            autoComplete="new-password"
          />
          <div aria-live="polite">
            <div className="flex gap-1" aria-hidden="true">
              {[1, 2, 3].map((n) => <span key={n} className={`h-1 flex-1 rounded-full ${forca >= n ? (forca === 1 ? "bg-red-500" : forca === 2 ? "bg-amber-500" : "bg-green-600") : "bg-(--bg-hover)"}`} />)}
            </div>
            <p className="mt-1 text-mac-caption text-(--text-secondary)">
              {forcaTexto ? `Senha ${forcaTexto.toLowerCase()}. ` : ""}Pelo menos 8 caracteres; com 12 ou mais e letras, números e símbolos ela fica forte.
            </p>
          </div>
          <Input
            label="Confirmar nova senha"
            type={show ? "text" : "password"}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={errors.confirm}
            autoComplete="new-password"
          />
          <label className="flex items-center gap-2 text-mac-body text-(--text-primary) cursor-pointer">
            <Checkbox checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostrar as senhas
          </label>
          <div className="flex justify-end pt-2">
            <Button type="submit" loading={saving} size="sm">
              Atualizar senha
            </Button>
          </div>
        </form>
        )}
      </Cartao>
      <MfaSection />
      <SessionsSection />
      <IntegritySection />
    </div>
  );
}
