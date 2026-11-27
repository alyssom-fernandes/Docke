import { useEffect, useId, useState } from "react";
import { Check, Copy, Inbox, Link2, Lock } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { relativeDate } from "@/lib/date";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Dropdown from "@/components/ui/Dropdown";
import Checkbox from "@/components/ui/Checkbox";

interface Pedido {
  id: string; token: string; title: string; message: string | null; expires_at: string; max_files: number;
  status: "aberto" | "vencido" | "revogado" | "lotado"; received: number; has_password: boolean;
  created_by_name: string | null; created_at: string; last_received_at: string | null;
}
interface Recebido { id: string; document_id: string | null; sender_name: string; file_name: string; confirmed_at: string; available: boolean }

const VALIDADES = [
  { value: "1", label: "1 dia" }, { value: "3", label: "3 dias" }, { value: "7", label: "7 dias" },
  { value: "15", label: "15 dias" }, { value: "30", label: "30 dias" }, { value: "90", label: "90 dias" },
];
const STATUS: Record<Pedido["status"], string> = { aberto: "aberto", vencido: "vencido", revogado: "encerrado", lotado: "completo" };

function linkDe(token: string) { return `${window.location.origin}/enviar/${token}`; }

/**
 * Pedir arquivos a terceiros (FA-A4-11, B3.5.8): cria um link de envio para a
 * pasta e mostra os pedidos dela com o que já chegou.
 */
export default function RequestFilesModal({ companyId, folder, obligation, onClose }: {
  companyId: string; folder: { id: string; name: string };
  /** A7-55, B3.5.8: o que chegar já comprova esta competência. */
  obligation?: { id: string; label: string };
  onClose: () => void;
}) {
  const uid = useId();
  const { success, error: showError } = useToast();
  const [pedidos, setPedidos] = useState<Pedido[] | null>(null);
  const [criando, setCriando] = useState(false);
  const [titulo, setTitulo] = useState(obligation ? `Comprovante: ${obligation.label}`.slice(0, 120) : `Arquivos para ${folder.name}`);
  const [mensagem, setMensagem] = useState("");
  const [dias, setDias] = useState("7");
  const [usarSenha, setUsarSenha] = useState(false);
  const [senha, setSenha] = useState("");
  const [maxArquivos, setMaxArquivos] = useState("20");
  const [pol, setPol] = useState<{ require_password: boolean; max_days: number | null }>({ require_password: false, max_days: null });
  const [novo, setNovo] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [recebidos, setRecebidos] = useState<Recebido[] | null>(null);
  const [busy, setBusy] = useState(false);

  function carregar() {
    api.get<Pedido[]>("/upload-requests", { params: { company_id: companyId, folder_id: folder.id } })
      .then((r) => { setPedidos(r.data); if (!r.data.length) setCriando(true); })
      .catch(() => setPedidos([]));
  }
  useEffect(carregar, [companyId, folder.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.get(`/companies/${companyId}/share-policy`).then((r) => {
      setPol(r.data);
      if (r.data?.require_password) setUsarSenha(true);
      if (r.data?.max_days && Number(dias) > r.data.max_days) setDias(String(VALIDADES.filter((v) => Number(v.value) <= r.data.max_days).pop()?.value ?? "1"));
    }).catch(() => {});
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!aberto) { setRecebidos(null); return; }
    api.get<Recebido[]>(`/upload-requests/${aberto}/files`).then((r) => setRecebidos(r.data)).catch(() => setRecebidos([]));
  }, [aberto]);

  async function copiar(token: string) {
    try { await navigator.clipboard.writeText(linkDe(token)); setCopiado(token); window.setTimeout(() => setCopiado(null), 1600); }
    catch { showError("Não foi possível copiar. Selecione o link e copie à mão."); }
  }

  async function criar() {
    setBusy(true);
    try {
      const r = await api.post("/upload-requests", {
        company_id: companyId, folder_id: folder.id, title: titulo.trim(), message: mensagem.trim() || null,
        expires_days: Number(dias), password: usarSenha ? senha : null, max_files: Number(maxArquivos) || 20,
        obligation_instance_id: obligation?.id ?? null,
      });
      setNovo(r.data.token);
      setCriando(false);
      setSenha("");
      carregar();
      copiar(r.data.token);
    } catch (e) {
      showError(friendlyError(e, "Não foi possível criar o pedido."));
    } finally {
      setBusy(false);
    }
  }

  async function encerrar(id: string) {
    setBusy(true);
    try { await api.post(`/upload-requests/${id}/revoke`); success("Pedido encerrado: o link para de aceitar arquivos."); carregar(); }
    catch (e) { showError(friendlyError(e, "Não foi possível encerrar.")); }
    finally { setBusy(false); }
  }

  const opcoesDias = pol.max_days ? VALIDADES.filter((v) => Number(v.value) <= pol.max_days!) : VALIDADES;
  const podeCriar = titulo.trim().length > 0 && (!usarSenha || senha.length >= 4);

  return (
    <Dialog onClose={onClose} title="Pedir arquivos" size="md" busy={busy}
      description={<>Gere um link para alguém de fora (contador, fornecedor, funcionário) mandar arquivos direto para <strong>{folder.name}</strong>, sem precisar de conta.</>}>
      <div className="space-y-5">
        {obligation && (
          <p className="rounded-(--radius-control) bg-(--tint-accent) px-3 py-2 text-mac-caption text-(--text-primary)">
            O que chegar por este link já comprova <strong className="font-medium">{obligation.label}</strong>
            {" "}e vai para a conferência, se a obrigação pede. Você recebe o aviso quando chegar.
          </p>
        )}
        {novo && (
          <div role="status" className="rounded-(--radius-control) border border-(--border-default) bg-(--bg-hover) p-3 space-y-2">
            <p className="flex items-center gap-1.5 text-mac-body font-medium text-(--text-primary)"><Check className="w-4 h-4 text-(--text-success)" aria-hidden="true" /> Link criado{copiado === novo ? " e copiado" : ""}. Mande para quem vai enviar.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-mac-caption text-(--text-secondary) select-all">{linkDe(novo)}</code>
              <Button size="sm" variant="secondary" onClick={() => copiar(novo)}><Copy className="w-3.5 h-3.5" aria-hidden="true" /> Copiar</Button>
            </div>
          </div>
        )}

        {criando ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (podeCriar) criar(); }}>
            <Input label="Título (quem envia vê)" value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={120} required />
            <div className="flex flex-col gap-1">
              <label htmlFor={`${uid}-msg`} className="text-mac-body font-medium text-(--text-secondary)">Recado (opcional)</label>
              <textarea id={`${uid}-msg`} value={mensagem} onChange={(e) => setMensagem(e.target.value)} maxLength={1000} rows={3}
                placeholder="Ex.: mande as notas de novembro e os extratos do mês."
                className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span id={`${uid}-val`} className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Validade</span>
                <Dropdown value={dias} onChange={setDias} options={opcoesDias} ariaLabelledby={`${uid}-val`} />
              </div>
              <Input label="Máximo de arquivos" type="number" min={1} max={200} value={maxArquivos} onChange={(e) => setMaxArquivos(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-mac-body text-(--text-primary)">
              <Checkbox checked={usarSenha} disabled={pol.require_password} onChange={(e) => setUsarSenha(e.target.checked)} />
              Pedir senha{pol.require_password && <span className="text-mac-caption text-(--text-secondary)">(obrigatória nesta empresa)</span>}
            </label>
            {usarSenha && <Input label="Senha (combine com quem vai enviar)" type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)}
              error={senha && senha.length < 4 ? "Use ao menos 4 caracteres." : undefined} />}
            <div className="flex justify-end gap-2 pt-1">
              {!!pedidos?.length && <Button type="button" variant="ghost" onClick={() => setCriando(false)}>Cancelar</Button>}
              <Button type="submit" loading={busy} disabled={!podeCriar}><Link2 className="w-4 h-4" aria-hidden="true" /> Criar link</Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" onClick={() => { setNovo(null); setCriando(true); }}><Link2 className="w-4 h-4" aria-hidden="true" /> Novo pedido</Button>
        )}

        {pedidos === null ? (
          <div className="h-16 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />
        ) : pedidos.length > 0 && (
          <section aria-labelledby={`${uid}-lista`} className="space-y-2">
            <h3 id={`${uid}-lista`} className="text-mac-body font-semibold text-(--text-primary)">Pedidos desta pasta</h3>
            <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
              {pedidos.map((p) => (
                <li key={p.id} className="px-3 py-2.5 space-y-1.5">
                  <div className="flex items-start gap-2">
                    <Inbox className="w-4 h-4 mt-0.5 shrink-0 text-(--text-secondary)" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <p className="text-mac-body text-(--text-primary) truncate">{p.title} {p.has_password && <Lock className="inline w-3 h-3 text-(--text-secondary)" aria-label="com senha" />}</p>
                      <p className="text-mac-caption text-(--text-secondary)">
                        {STATUS[p.status]} · {p.received} de {p.max_files} {p.max_files === 1 ? "arquivo" : "arquivos"}
                        {p.status === "aberto" ? ` · vale até ${new Date(p.expires_at).toLocaleDateString("pt-BR")}` : ""}
                        {p.last_received_at ? ` · último ${relativeDate(p.last_received_at)}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pl-6">
                    {p.received > 0 && <Button size="sm" variant="ghost" onClick={() => setAberto(aberto === p.id ? null : p.id)} aria-expanded={aberto === p.id}>{aberto === p.id ? "Esconder recebidos" : "Ver recebidos"}</Button>}
                    {p.status === "aberto" && <Button size="sm" variant="ghost" onClick={() => copiar(p.token)}><Copy className="w-3.5 h-3.5" aria-hidden="true" /> {copiado === p.token ? "Copiado" : "Copiar link"}</Button>}
                    {p.status !== "revogado" && p.status !== "vencido" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => encerrar(p.id)}>Encerrar</Button>}
                  </div>
                  {aberto === p.id && (
                    <ul className="pl-6 space-y-1">
                      {recebidos === null ? <li className="h-6 rounded bg-(--bg-hover) animate-pulse" /> : recebidos.map((x) => (
                        <li key={x.id} className="text-mac-caption text-(--text-secondary)">
                          <span className="text-(--text-primary)">{x.file_name}</span>{x.available ? "" : " (já não está na pasta)"} · {x.sender_name} · {relativeDate(x.confirmed_at)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}
