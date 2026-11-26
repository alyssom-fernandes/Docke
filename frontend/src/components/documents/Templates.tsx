import { Fragment, useEffect, useRef, useState } from "react";
import { FolderTree, Download, Upload, RotateCcw, Trash2, FileText, LayoutTemplate } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import Input from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";

/*
 * Modelos (B1.5.4, B1.5.5, B1.5.6, B1.5.8): salvar a árvore de uma pasta como
 * modelo, aplicar sem apagar nada (com política para nome repetido), criar
 * documento a partir de um documento-modelo e exportar/importar o pacote de
 * configuração da empresa.
 */

export interface TemplateSummary {
  id: string; name: string; description: string | null; version: number; updated_at: string;
  folders: number; fields: number; top: string[];
}

interface ApplyResult { criadas: string[]; mescladas: string[]; puladas: string[]; regras_de_campo: number; campos_criados: number; dry_run: boolean }

const erro = (e: any, padrao: string) => e?.response?.data?.detail && typeof e.response.data.detail === "string" ? e.response.data.detail : padrao;
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

export function SaveTemplateDialog({ companyId, folder, onClose }: { companyId: string; folder: { id: string; name: string }; onClose: () => void }) {
  const { success, error: showError } = useToast();
  const [name, setName] = useState(folder.name);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  async function salvar() {
    setBusy(true);
    try {
      const r = await api.post<TemplateSummary>(`/companies/${companyId}/structure-templates`, { name: name.trim(), description: description.trim() || null, source_folder_id: folder.id });
      success(`Modelo "${r.data.name}" salvo: ${plural(r.data.folders, "pasta", "pastas")} e ${plural(r.data.fields, "campo", "campos")}.`);
      onClose();
    } catch (e) {
      showError(erro(e, "Não foi possível salvar o modelo."));
    } finally { setBusy(false); }
  }
  return (
    <Dialog onClose={onClose} size="sm" busy={busy} title={`Salvar "${folder.name}" como modelo`}
      description="Guarda as subpastas, a classificação LGPD e os campos de metadados com os valores padrão. Os documentos não entram."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!name.trim()} onClick={salvar}>Salvar modelo</Button></>}>
      <div className="space-y-3">
        <Input label="Nome do modelo" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Admissão de colaborador" />
        <Input label="Descrição (opcional)" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="Para que serve e quando usar" />
      </div>
    </Dialog>
  );
}

function ResultList({ r }: { r: ApplyResult }) {
  const bloco = (titulo: string, itens: string[]) => itens.length > 0 && (
    <div>
      <p className="text-mac-caption font-medium text-(--text-secondary)">{titulo} ({itens.length})</p>
      <ul className="mt-1 max-h-28 overflow-auto text-mac-caption text-(--text-primary) space-y-0.5">
        {itens.slice(0, 50).map((i) => <li key={i} className="truncate">{i}</li>)}
        {itens.length > 50 && <li className="text-(--text-tertiary)">e mais {itens.length - 50}</li>}
      </ul>
    </div>
  );
  return (
    <div className="mt-3 rounded-(--radius-control) border border-(--border-default) p-3 space-y-2" role="status" aria-live="polite">
      {bloco("Pastas novas", r.criadas)}
      {bloco("Pastas que já existem e recebem o que falta", r.mescladas)}
      {bloco("Ramos deixados de fora (nome repetido)", r.puladas)}
      <p className="text-mac-caption text-(--text-secondary)">
        {plural(r.regras_de_campo, "campo aplicado", "campos aplicados")} nas pastas{r.campos_criados > 0 ? `, ${plural(r.campos_criados, "campo novo", "campos novos")} na empresa` : ""}. Nada é apagado nem renomeado.
      </p>
    </div>
  );
}

export function ApplyTemplateDialog({ companyId, folder, onClose, onDone }: { companyId: string; folder: { id: string; name: string } | null; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [modelos, setModelos] = useState<TemplateSummary[] | null>(null);
  const [escolhido, setEscolhido] = useState("");
  const [modo, setModo] = useState<"dentro" | "subpasta">(folder ? "dentro" : "subpasta");
  const [conflito, setConflito] = useState<"mesclar" | "renomear" | "pular">("mesclar");
  const [previa, setPrevia] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<TemplateSummary[]>(`/companies/${companyId}/structure-templates`)
      .then((r) => { setModelos(r.data); if (r.data[0]) setEscolhido(r.data[0].id); })
      .catch(() => setModelos([]));
  }, [companyId]);
  useEffect(() => setPrevia(null), [escolhido, modo, conflito]);

  function corpo(dry: boolean) {
    return {
      target_folder_id: folder && modo === "dentro" ? folder.id : null,
      target_parent_id: folder && modo === "subpasta" ? folder.id : null,
      conflito, dry_run: dry,
    };
  }
  async function rodar(dry: boolean) {
    setBusy(true);
    try {
      const r = await api.post<ApplyResult>(`/structure-templates/${escolhido}/apply`, corpo(dry));
      if (dry) { setPrevia(r.data); return; }
      success(`Modelo aplicado: ${plural(r.data.criadas.length, "pasta nova", "pastas novas")}${r.data.mescladas.length ? `, ${plural(r.data.mescladas.length, "existente completada", "existentes completadas")}` : ""}.`);
      onDone();
      onClose();
    } catch (e) {
      showError(erro(e, "Não foi possível aplicar o modelo."));
    } finally { setBusy(false); }
  }

  const opcoesConflito = [
    { v: "mesclar" as const, t: "Completar a pasta que já existe", d: "Entra nela e cria só as subpastas e os campos que faltam." },
    { v: "renomear" as const, t: "Criar outra com número", d: "Ex.: \"Exames (1)\" ao lado da que já existe." },
    { v: "pular" as const, t: "Deixar de fora", d: "Não mexe naquele ramo." },
  ];
  return (
    <Dialog onClose={onClose} size="md" busy={busy} title={folder ? `Aplicar modelo em "${folder.name}"` : "Aplicar modelo"}
      description="Cria a estrutura do modelo sem apagar nem renomear o que já existe."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button variant="secondary" loading={busy && !previa} disabled={!escolhido} onClick={() => rodar(true)}>Ver o que muda</Button>
        <Button loading={busy && !!previa} disabled={!escolhido || !previa} onClick={() => rodar(false)}>Aplicar</Button>
      </>}>
      {modelos === null ? <div className="h-20 animate-pulse rounded-(--radius-control) bg-(--bg-card)" /> : modelos.length === 0 ? (
        <p className="text-mac-body text-(--text-secondary)">Nenhum modelo salvo ainda. No menu de uma pasta pronta, escolha <strong>Salvar como modelo…</strong></p>
      ) : (
        <div className="space-y-4">
          <div>
            <span id="tpl-escolha" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Modelo</span>
            <Dropdown ariaLabelledby="tpl-escolha" value={escolhido} onChange={setEscolhido}
              options={modelos.map((m) => ({ value: m.id, label: `${m.name} · ${plural(m.folders, "pasta", "pastas")} · v${m.version}` }))} />
          </div>
          {folder && (
            <div role="radiogroup" aria-label="Onde aplicar" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {([["dentro", "Dentro desta pasta", `O conteúdo do modelo entra em "${folder.name}".`], ["subpasta", "Como subpasta", `A pasta do modelo é criada dentro de "${folder.name}".`]] as const).map(([v, t, d]) => (
                <button key={v} type="button" role="radio" aria-checked={modo === v} onClick={() => setModo(v)}
                  className={`text-left rounded-(--radius-control) border p-3 transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${modo === v ? "border-teal-600 bg-teal-500/10" : "border-(--border-control) hover:bg-(--bg-hover)"}`}>
                  <span className="block text-mac-body font-medium text-(--text-primary)">{t}</span>
                  <span className="block text-mac-caption text-(--text-secondary)">{d}</span>
                </button>
              ))}
            </div>
          )}
          <div>
            <p className="mb-1 text-mac-body font-medium text-(--text-secondary)">Se já houver uma pasta com o mesmo nome</p>
            <div role="radiogroup" aria-label="Se já houver uma pasta com o mesmo nome" className="space-y-1.5">
              {opcoesConflito.map((o) => (
                <button key={o.v} type="button" role="radio" aria-checked={conflito === o.v} onClick={() => setConflito(o.v)}
                  className={`w-full text-left rounded-(--radius-control) border px-3 py-2 transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${conflito === o.v ? "border-teal-600 bg-teal-500/10" : "border-(--border-control) hover:bg-(--bg-hover)"}`}>
                  <span className="block text-mac-body text-(--text-primary)">{o.t}</span>
                  <span className="block text-mac-caption text-(--text-secondary)">{o.d}</span>
                </button>
              ))}
            </div>
          </div>
          {previa ? <ResultList r={previa} /> : <p className="text-mac-caption text-(--text-secondary)">Confira antes em <strong>Ver o que muda</strong>; depois, Aplicar.</p>}
        </div>
      )}
    </Dialog>
  );
}

interface DocTemplate { id: string; name: string; folder_name: string; fields: { label: string; value: string }[] }

export function NewFromTemplateDialog({ companyId, folder, onClose, onDone }: { companyId: string; folder: { id: string; name: string }; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [lista, setLista] = useState<DocTemplate[] | null>(null);
  const [escolhido, setEscolhido] = useState("");
  const [nome, setNome] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<DocTemplate[]>(`/companies/${companyId}/document-templates`)
      .then((r) => { setLista(r.data); if (r.data[0]) setEscolhido(r.data[0].id); })
      .catch(() => setLista([]));
  }, [companyId]);
  const atual = lista?.find((d) => d.id === escolhido);
  async function criar() {
    setBusy(true);
    try {
      const r = await api.post(`/document-templates/${escolhido}/new`, { folder_id: folder.id, name: nome.trim() || null });
      success(`"${r.data.name}" criado em ${folder.name}${r.data.fields_copied ? ` com ${plural(r.data.fields_copied, "metadado", "metadados")} preenchidos` : ""}.`);
      onDone();
      onClose();
    } catch (e) {
      showError(erro(e, "Não foi possível criar o documento."));
    } finally { setBusy(false); }
  }
  return (
    <Dialog onClose={onClose} size="sm" busy={busy} title={`Novo documento em "${folder.name}"`}
      description="Copia um documento-modelo com os metadados já preenchidos."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!escolhido} onClick={criar}>Criar</Button></>}>
      {lista === null ? <div className="h-20 animate-pulse rounded-(--radius-control) bg-(--bg-card)" /> : lista.length === 0 ? (
        <p className="text-mac-body text-(--text-secondary)">Nenhum documento-modelo ainda. Quem administra a pasta marca um documento em <strong>Marcar como modelo</strong> no menu dele.</p>
      ) : (
        <div className="space-y-3">
          <div>
            <span id="doc-tpl" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Modelo</span>
            <Dropdown ariaLabelledby="doc-tpl" value={escolhido} onChange={setEscolhido}
              options={lista.map((d) => ({ value: d.id, label: `${d.name} · ${d.folder_name}` }))} />
          </div>
          <Input label="Nome do documento novo (opcional)" value={nome} maxLength={200} onChange={(e) => setNome(e.target.value)} placeholder={atual?.name.replace(/\.[^.]+$/, "")} />
          {atual && atual.fields.length > 0 && (
            <dl className="rounded-(--radius-control) border border-(--border-default) p-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-mac-caption">
              {atual.fields.map((f) => (<Fragment key={f.label}><dt className="text-(--text-secondary)">{f.label}</dt><dd className="text-(--text-primary) truncate">{f.value}</dd></Fragment>))}
            </dl>
          )}
        </div>
      )}
    </Dialog>
  );
}

interface ImportResult {
  campos_criados: number; regras_gerais: number; modelos_criados: number; modelos_atualizados: number;
  retencao_criadas: number; papeis_criados: number; pastas: { criadas: number; mescladas: number } | null; ignorados: string[]; dry_run: boolean;
}

/** Ajustes → Organização: modelos salvos (versões, restaurar, excluir) e o pacote de configuração. */
export function TemplatesSection({ companyId, companyName }: { companyId: string; companyName: string }) {
  const { success, error: showError } = useToast();
  const [modelos, setModelos] = useState<TemplateSummary[] | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [versoes, setVersoes] = useState<{ version: number; saved_at: string; saved_by_name: string | null; folders: number }[]>([]);
  const [exportando, setExportando] = useState(false);
  const [pacote, setPacote] = useState<{ nome: string; dados: any } | null>(null);
  const [incluirPastas, setIncluirPastas] = useState(false);
  const [previa, setPrevia] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [apagar, setApagar] = useState<TemplateSummary | null>(null);
  const arquivo = useRef<HTMLInputElement>(null);

  function load() {
    api.get<TemplateSummary[]>(`/companies/${companyId}/structure-templates`).then((r) => setModelos(r.data)).catch(() => setModelos([]));
  }
  useEffect(load, [companyId]);

  async function abrir(id: string) {
    if (aberto === id) { setAberto(null); return; }
    setAberto(id);
    setVersoes([]);
    const r = await api.get(`/structure-templates/${id}`).catch(() => null);
    setVersoes(r?.data?.versions ?? []);
  }
  async function restaurar(id: string, v: number) {
    try {
      const r = await api.post<TemplateSummary>(`/structure-templates/${id}/restore/${v}`);
      success(`Versão ${v} restaurada como versão ${r.data.version}.`);
      load(); setAberto(null);
    } catch (e) { showError(erro(e, "Não foi possível restaurar a versão.")); }
  }
  async function excluir() {
    if (!apagar) return;
    setBusy(true);
    try {
      await api.delete(`/structure-templates/${apagar.id}`);
      success(`Modelo "${apagar.name}" excluído. As pastas criadas com ele continuam.`);
      setApagar(null); load();
    } catch (e) { showError(erro(e, "Não foi possível excluir o modelo.")); } finally { setBusy(false); }
  }
  async function exportar() {
    setExportando(true);
    try {
      const r = await api.get(`/companies/${companyId}/config-package`);
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `configuracao-${companyName.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      success("Pacote de configuração baixado.");
    } catch (e) { showError(erro(e, "Não foi possível exportar a configuração.")); } finally { setExportando(false); }
  }
  async function lerArquivo(f: File | undefined) {
    if (!f) return;
    try {
      const dados = JSON.parse(await f.text());
      if (dados?.formato !== "docke-configuracao") throw new Error();
      setPacote({ nome: f.name, dados }); setPrevia(null);
    } catch { showError("Este arquivo não é um pacote de configuração do Docke."); }
    if (arquivo.current) arquivo.current.value = "";
  }
  async function importar(dry: boolean) {
    if (!pacote) return;
    setBusy(true);
    try {
      const r = await api.post<ImportResult>(`/companies/${companyId}/config-package`, { pacote: pacote.dados, incluir_pastas: incluirPastas, dry_run: dry });
      if (dry) { setPrevia(r.data); return; }
      success("Configuração importada. Nada do que já existia foi alterado.");
      setPacote(null); setPrevia(null); load();
    } catch (e) { showError(erro(e, "Não foi possível importar a configuração.")); } finally { setBusy(false); }
  }

  return (
    <div className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 space-y-4">
      <div className="flex items-center gap-2">
        <LayoutTemplate className="w-4 h-4 text-(--text-accent) shrink-0" aria-hidden />
        <h2 className="text-mac-body font-semibold text-(--text-primary) truncate">Modelos e configuração <span className="text-(--text-tertiary) font-normal">de</span> {companyName}</h2>
      </div>
      <p className="text-mac-caption text-(--text-secondary)">Salve a estrutura de uma pasta pelo menu dela (<strong>Salvar como modelo…</strong>) e aplique em outra com <strong>Aplicar modelo…</strong>. Cada vez que um modelo é regravado, a versão anterior fica guardada.</p>
      {modelos === null ? <div className="h-16 animate-pulse rounded-(--radius-control) bg-(--bg-card)" /> : modelos.length === 0 ? (
        <p className="text-mac-body text-(--text-tertiary)">Nenhum modelo salvo.</p>
      ) : (
        <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
          {modelos.map((m) => (
            <li key={m.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <FolderTree className="w-4 h-4 text-(--text-secondary) shrink-0" aria-hidden />
                <button type="button" onClick={() => abrir(m.id)} aria-expanded={aberto === m.id}
                  className="flex-1 min-w-0 text-left focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) rounded-sm">
                  <span className="block text-mac-body text-(--text-primary) truncate">{m.name} <span className="text-(--text-tertiary)">· v{m.version}</span></span>
                  <span className="block text-mac-caption text-(--text-secondary) truncate">{plural(m.folders, "pasta", "pastas")}, {plural(m.fields, "campo", "campos")}{m.description ? ` · ${m.description}` : ""}</span>
                </button>
                <Button variant="ghost" size="sm" aria-label={`Excluir o modelo ${m.name}`} onClick={() => setApagar(m)}><Trash2 className="w-4 h-4" aria-hidden /></Button>
              </div>
              {aberto === m.id && (
                <div className="mt-2 ml-6 text-mac-caption">
                  {versoes.length === 0 ? <p className="text-(--text-tertiary)">Sem versões anteriores.</p> : (
                    <ul className="space-y-1">
                      {versoes.map((v) => (
                        <li key={v.version} className="flex items-center gap-2">
                          <span className="flex-1 text-(--text-secondary)">v{v.version} · {new Date(v.saved_at).toLocaleDateString("pt-BR")} · {plural(v.folders, "pasta", "pastas")}{v.saved_by_name ? ` · ${v.saved_by_name}` : ""}</span>
                          <Button variant="secondary" size="sm" onClick={() => restaurar(m.id, v.version)}><RotateCcw className="w-3.5 h-3.5" aria-hidden />Restaurar</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-(--border-default) pt-4 space-y-2">
        <p className="text-mac-body font-medium text-(--text-primary)">Pacote de configuração</p>
        <p className="text-mac-caption text-(--text-secondary)">Um arquivo com campos de metadados, modelos, regras de retenção, papéis e a árvore de pastas. Serve de cópia de segurança da configuração e para levar a mesma organização a outra empresa. Documentos e pessoas não entram.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" loading={exportando} onClick={exportar}><Download className="w-4 h-4" aria-hidden />Exportar</Button>
          <Button variant="secondary" size="sm" onClick={() => arquivo.current?.click()}><Upload className="w-4 h-4" aria-hidden />Importar…</Button>
          <input ref={arquivo} type="file" accept="application/json,.json" className="hidden" onChange={(e) => lerArquivo(e.target.files?.[0])} />
        </div>
      </div>
      {pacote && (
        <Dialog onClose={() => setPacote(null)} size="md" busy={busy} title={`Importar "${pacote.nome}"`}
          description={`Vindo de ${pacote.dados.empresa ?? "outra empresa"}. Só acrescenta: o que já existe aqui fica como está.`}
          footer={<>
            <Button variant="secondary" onClick={() => setPacote(null)}>Cancelar</Button>
            <Button variant="secondary" loading={busy && !previa} onClick={() => importar(true)}>Ver o que muda</Button>
            <Button loading={busy && !!previa} disabled={!previa} onClick={() => importar(false)}>Importar</Button>
          </>}>
          <label className="flex items-center gap-2.5 min-h-8 cursor-pointer text-mac-body text-(--text-primary)">
            <Checkbox checked={incluirPastas} onChange={(e) => { setIncluirPastas(e.target.checked); setPrevia(null); }} />
            Criar também as pastas que faltam (mescla pelo nome)
          </label>
          {previa && (
            <ul className="mt-3 rounded-(--radius-control) border border-(--border-default) p-3 text-mac-caption text-(--text-primary) space-y-0.5" role="status" aria-live="polite">
              <li>{plural(previa.campos_criados, "campo novo", "campos novos")}, {plural(previa.regras_gerais, "regra geral", "regras gerais")}</li>
              <li>{plural(previa.modelos_criados, "modelo novo", "modelos novos")}, {plural(previa.modelos_atualizados, "modelo com versão nova", "modelos com versão nova")}</li>
              <li>{plural(previa.retencao_criadas, "regra de retenção", "regras de retenção")}, {plural(previa.papeis_criados, "papel", "papéis")}</li>
              {previa.pastas && <li>{plural(previa.pastas.criadas, "pasta nova", "pastas novas")}, {plural(previa.pastas.mescladas, "existente", "existentes")}</li>}
              {previa.ignorados.length > 0 && <li className="text-(--text-warning)">Ignorados: {previa.ignorados.join("; ")}</li>}
            </ul>
          )}
        </Dialog>
      )}
      {apagar && (
        <Dialog onClose={() => setApagar(null)} size="sm" busy={busy} title={`Excluir o modelo "${apagar.name}"?`}
          description="As pastas já criadas com ele continuam como estão."
          footer={<><Button variant="secondary" onClick={() => setApagar(null)}>Cancelar</Button><Button variant="danger" loading={busy} onClick={excluir}>Excluir</Button></>}>
          <p className="text-mac-body text-(--text-secondary)"><FileText className="inline w-4 h-4 mr-1" aria-hidden />{plural(apagar.folders, "pasta", "pastas")} e {plural(apagar.fields, "campo", "campos")} na versão {apagar.version}.</p>
        </Dialog>
      )}
    </div>
  );
}
