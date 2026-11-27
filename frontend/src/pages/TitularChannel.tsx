import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ShieldCheck, Copy, Search as SearchIcon } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Dropdown from "@/components/ui/Dropdown";
import Wallpaper from "@/components/layout/Wallpaper";

const API_BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:8000") + "/api/v1";

/*
 * Canal do titular (LGPD art. 18; benchmark B3.7.2): sem login, a pessoa
 * pede acesso, correção, eliminação etc. dos próprios dados e recebe um
 * protocolo e um código para acompanhar. Só existe se a empresa ligar o canal.
 */

const STATUS: Record<string, string> = {
  recebido: "Recebido", verificando: "Conferindo a sua identidade", em_andamento: "Em atendimento",
  concluido: "Concluído", negado: "Não atendido",
};

async function chamar(url: string, init?: RequestInit) {
  try {
    const r = await fetch(url, init);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Não foi possível concluir. Tente de novo.");
    return data;
  } catch (e) {
    if (e instanceof TypeError) throw new Error("Sem conexão com o servidor. Confira a internet e tente de novo.");
    throw e;
  }
}

export default function TitularChannel() {
  const { companyId } = useParams<{ companyId: string }>();
  const [info, setInfo] = useState<{ company_name: string; prazo_dias: number; tipos: Record<string, string> } | null>(null);
  const [erroCanal, setErroCanal] = useState<string | null>(null);
  const [aba, setAba] = useState<"pedir" | "acompanhar">("pedir");
  const [tipo, setTipo] = useState("acesso");
  const [nome, setNome] = useState("");
  const [cpf, setCpf] = useState("");
  const [contato, setContato] = useState("");
  const [descricao, setDescricao] = useState("");
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [recibo, setRecibo] = useState<{ protocolo: string; codigo: string; prazo: string } | null>(null);
  const [proto, setProto] = useState("");
  const [codigo, setCodigo] = useState("");
  const [situacao, setSituacao] = useState<{ protocolo: string; tipo: string; status: string; prazo: string; resposta: string | null; empresa: string } | null>(null);

  useEffect(() => {
    document.title = "Pedido sobre os seus dados · Docke";
    chamar(`${API_BASE}/public/titular/${companyId}`).then(setInfo).catch((e) => setErroCanal(e.message));
  }, [companyId]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErro(null);
    try {
      const r = await chamar(`${API_BASE}/public/titular/${companyId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo, titular_nome: nome.trim(), titular_cpf: cpf, contato: contato.trim(), descricao: descricao.trim() || null }),
      });
      setRecibo(r);
    } catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  async function consultar(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErro(null); setSituacao(null);
    try {
      setSituacao(await chamar(`${API_BASE}/public/titular-status`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocolo: proto.trim(), codigo: codigo.trim() }),
      }));
    } catch (e: any) { setErro(e.message); } finally { setBusy(false); }
  }
  const dataBr = (d: string) => new Date(d + (d.length === 10 ? "T12:00:00" : "")).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

  return (
    <main className="wallpaper-screen relative isolate min-h-dvh overflow-x-hidden flex flex-col items-center px-4 py-10">
      <Wallpaper fixed />
      <div className="relative w-full max-w-[560px]">
        <div className="flex items-center justify-center mb-8">
          <div className="brand-wordmark w-[130px] h-[37px] bg-white!" role="img" aria-label="Docke" />
        </div>
        <div className="mac-window p-6">
          {erroCanal ? (
            <p role="alert" className="text-mac-body text-(--text-primary)">{erroCanal}</p>
          ) : !info ? (
            <div className="h-40 animate-pulse rounded-(--radius-control) bg-(--bg-hover)" role="status" aria-label="Carregando" />
          ) : (
            <>
              <div className="flex items-start gap-3 mb-5">
                <ShieldCheck className="w-6 h-6 text-(--text-accent) shrink-0" aria-hidden />
                <div>
                  <h1 className="text-mac-title3 font-semibold text-(--text-primary)">Pedido sobre os seus dados</h1>
                  <p className="text-mac-caption text-(--text-secondary)">{info.company_name} · Lei Geral de Proteção de Dados (art. 18). Prazo de referência para a resposta: {info.prazo_dias} dias.</p>
                </div>
              </div>
              <div role="tablist" aria-label="O que você quer fazer" className="mac-segmented is-fill mb-4">
                {([["pedir", "Fazer um pedido"], ["acompanhar", "Acompanhar"]] as const).map(([v, t]) => (
                  <button key={v} role="tab" aria-selected={aba === v} onClick={() => { setAba(v); setErro(null); }}
                    className="mac-segment">{t}</button>
                ))}
              </div>
              {erro && <p role="alert" className="mb-3 rounded-(--radius-control) bg-(--tint-danger) px-3 py-2 text-mac-caption text-(--text-primary)">{erro}</p>}
              {aba === "pedir" && (recibo ? (
                <div className="reveal space-y-3" role="status">
                  <p className="text-mac-body text-(--text-primary)">Pedido recebido. Guarde estes dados para acompanhar:</p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-(--radius-control) border border-(--border-default) p-3">
                    <dt className="text-(--text-secondary)">Protocolo</dt><dd className="font-mono text-(--text-primary)">{recibo.protocolo}</dd>
                    <dt className="text-(--text-secondary)">Código</dt><dd className="font-mono text-(--text-primary)">{recibo.codigo}</dd>
                    <dt className="text-(--text-secondary)">Prazo</dt><dd className="text-(--text-primary)">{dataBr(recibo.prazo)}</dd>
                  </dl>
                  <p className="text-mac-caption text-(--text-secondary)">A empresa pode pedir um documento para confirmar que é você antes de responder. O código não aparece de novo.</p>
                  <Button variant="secondary" size="sm" onClick={() => navigator.clipboard?.writeText(`Protocolo ${recibo.protocolo} · código ${recibo.codigo}`)}><Copy className="w-3.5 h-3.5" aria-hidden />Copiar</Button>
                </div>
              ) : (
                <form onSubmit={enviar} className="space-y-3">
                  <div>
                    <span id="tit-tipo" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">O que você pede</span>
                    <Dropdown ariaLabelledby="tit-tipo" value={tipo} onChange={setTipo}
                      options={Object.entries(info.tipos).map(([value, label]) => ({ value, label: label.charAt(0).toUpperCase() + label.slice(1) }))} />
                  </div>
                  <Input label="Seu nome completo" value={nome} onChange={(e) => setNome(e.target.value)} required minLength={2} maxLength={200} autoComplete="name" />
                  <Input label="Seu CPF" value={cpf} onChange={(e) => setCpf(e.target.value)} required inputMode="numeric" maxLength={14} placeholder="000.000.000-00" />
                  <Input label="E-mail ou telefone para a resposta" value={contato} onChange={(e) => setContato(e.target.value)} required minLength={5} maxLength={200} autoComplete="email" />
                  <div className="flex flex-col gap-1">
                    <label htmlFor="tit-desc" className="text-mac-body font-medium text-(--text-secondary)">Detalhes (opcional)</label>
                    <textarea id="tit-desc" rows={3} maxLength={2000} value={descricao} onChange={(e) => setDescricao(e.target.value)}
                      placeholder="Ex.: qual dado corrigir, período em que trabalhou na empresa"
                      className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
                  </div>
                  <p className="text-mac-caption text-(--text-secondary)">O CPF serve só para achar os seus dados; ele não fica guardado em claro.</p>
                  <Button type="submit" loading={busy} disabled={nome.trim().length < 2 || cpf.replace(/\D/g, "").length !== 11 || contato.trim().length < 5}>Enviar pedido</Button>
                </form>
              ))}
              {aba === "acompanhar" && (
                <form onSubmit={consultar} className="space-y-3">
                  <Input label="Protocolo" value={proto} onChange={(e) => setProto(e.target.value.toUpperCase())} placeholder="LGPD-2026-XXXXXX" required />
                  <Input label="Código" value={codigo} onChange={(e) => setCodigo(e.target.value.toUpperCase())} required />
                  <Button type="submit" loading={busy} disabled={!proto.trim() || !codigo.trim()}><SearchIcon className="w-3.5 h-3.5" aria-hidden />Consultar</Button>
                  {situacao && (
                    <div className="reveal rounded-(--radius-control) border border-(--border-default) p-3 space-y-1" role="status">
                      <p className="text-mac-body font-medium text-(--text-primary)">{STATUS[situacao.status] ?? situacao.status}</p>
                      <p className="text-mac-caption text-(--text-secondary)">{info.tipos[situacao.tipo]} · prazo {dataBr(situacao.prazo)}</p>
                      {situacao.resposta && <p className="whitespace-pre-wrap pt-2 text-mac-body text-(--text-primary)">{situacao.resposta}</p>}
                    </div>
                  )}
                </form>
              )}
            </>
          )}
        </div>
        <p className="wallpaper-note mt-6 text-center text-mac-caption">Canal mantido pelo Docke para {info?.company_name ?? "a empresa"}.</p>
      </div>
    </main>
  );
}
