import { useEffect, useRef, useState } from "react";
import { RotateCw, ChevronLeft, ChevronRight, Trash2, Undo2 } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/*
 * Organizar páginas (B2.4.5): girar, reordenar, remover e extrair. O servidor
 * monta o PDF novo; "Salvar como versão nova" guarda a anterior no histórico
 * e "Extrair" cria outro documento na mesma pasta. O original não muda.
 */

interface Item { indice: number; rotacao: 0 | 90 | 180 | 270; removida: boolean; marcada: boolean }

function Miniatura({ pdf, indice, rotacao }: { pdf: pdfjsLib.PDFDocumentProxy; indice: number; rotacao: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancel = false;
    pdf.getPage(indice + 1).then((page) => {
      if (cancel || !ref.current) return;
      const vp = page.getViewport({ scale: 1 });
      const scale = 120 / Math.max(vp.width, vp.height);
      const v = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const c = ref.current;
      c.width = v.width; c.height = v.height;
      c.style.width = `${v.width / (window.devicePixelRatio || 1)}px`;
      page.render({ canvas: null, canvasContext: c.getContext("2d")!, viewport: v });
    }).catch(() => {});
    return () => { cancel = true; };
  }, [pdf, indice]);
  return <canvas ref={ref} aria-hidden className="bg-white shadow-sm transition-transform duration-200" style={{ transform: `rotate(${rotacao}deg)` }} />;
}

export default function PageOrganizer({ docId, docName, url, onClose, onDone }: { docId: string; docName: string; url: string; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [itens, setItens] = useState<Item[]>([]);
  const [falhou, setFalhou] = useState(false);
  const [nome, setNome] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const task = pdfjsLib.getDocument({ url });
    task.promise.then((d) => { setPdf(d); setItens(Array.from({ length: d.numPages }, (_, i) => ({ indice: i, rotacao: 0, removida: false, marcada: false }))); })
      .catch(() => setFalhou(true));
    return () => { task.destroy(); };
  }, [url]);

  const mudar = (pos: number, f: (it: Item) => Item) => setItens((xs) => xs.map((it, i) => (i === pos ? f(it) : it)));
  function mover(pos: number, delta: number) {
    setItens((xs) => {
      const alvo = pos + delta;
      if (alvo < 0 || alvo >= xs.length) return xs;
      const n = [...xs];
      [n[pos], n[alvo]] = [n[alvo], n[pos]];
      return n;
    });
  }
  const mantidas = itens.filter((i) => !i.removida);
  const marcadas = itens.filter((i) => i.marcada && !i.removida);
  const mudou = itens.some((it, i) => it.indice !== i || it.rotacao || it.removida);

  async function enviar(modo: "versao" | "extrair") {
    const paginas = (modo === "versao" ? mantidas : marcadas).map((i) => ({ indice: i.indice, rotacao: i.rotacao }));
    if (!paginas.length) return;
    setBusy(true);
    try {
      const r = await api.post(`/documents/${docId}/pages`, { paginas, modo, nome: modo === "extrair" ? nome.trim() || null : null });
      success(modo === "versao"
        ? `Versão ${r.data.version_number} salva (${r.data.resumo}). A anterior continua no histórico.`
        : `"${r.data.name}" criado com ${r.data.paginas} ${r.data.paginas === 1 ? "página" : "páginas"}.`);
      onDone();
      onClose();
    } catch (e: any) {
      showError(typeof e?.response?.data?.detail === "string" ? e.response.data.detail : "Não foi possível organizar as páginas.");
    } finally { setBusy(false); }
  }

  const btn = "h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)";
  return (
    <Dialog onClose={onClose} size="xl" busy={busy} title={`Organizar páginas de "${docName}"`}
      description="Gire, mude a ordem ou tire páginas e salve como versão nova; ou marque páginas para extrair num documento novo. O arquivo original fica guardado."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button variant="secondary" loading={busy} disabled={!marcadas.length} onClick={() => enviar("extrair")}>Extrair {marcadas.length || ""} {marcadas.length === 1 ? "página" : "páginas"}</Button>
        <Button loading={busy} disabled={!mudou || !mantidas.length} onClick={() => enviar("versao")}>Salvar como versão nova</Button>
      </>}>
      {falhou ? <p role="alert" className="text-mac-body text-(--text-primary)">Não foi possível abrir o PDF para organizar.</p>
        : !pdf ? <div className="h-40 animate-pulse rounded-(--radius-control) bg-(--bg-hover)" role="status" aria-label="Carregando páginas" />
        : (
          <div className="space-y-3">
            <ol className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3" aria-label="Páginas">
              {itens.map((it, pos) => (
                <li key={`${it.indice}`} className={`rounded-(--radius-control) border p-2 flex flex-col items-center gap-2 ${it.removida ? "opacity-40 border-dashed border-(--border-default)" : it.marcada ? "border-teal-600 bg-(--tint-accent)" : "border-(--border-default)"}`}>
                  <div className="h-[130px] flex items-center justify-center"><Miniatura pdf={pdf} indice={it.indice} rotacao={it.rotacao} /></div>
                  <span className="text-mac-caption text-(--text-secondary)">Página {it.indice + 1}{pos !== it.indice ? ` → ${pos + 1}ª` : ""}{it.removida ? " · sai" : ""}</span>
                  <div className="flex items-center gap-0.5">
                    <button type="button" className={btn} onClick={() => mover(pos, -1)} disabled={pos === 0} aria-label={`Passar a página ${it.indice + 1} para antes`}><ChevronLeft className="w-4 h-4" aria-hidden /></button>
                    <button type="button" className={btn} onClick={() => mudar(pos, (x) => ({ ...x, rotacao: ((x.rotacao + 90) % 360) as Item["rotacao"] }))} aria-label={`Girar a página ${it.indice + 1}`}><RotateCw className="w-4 h-4" aria-hidden /></button>
                    <button type="button" className={btn} onClick={() => mudar(pos, (x) => ({ ...x, removida: !x.removida, marcada: false }))} aria-pressed={it.removida}
                      aria-label={it.removida ? `Manter a página ${it.indice + 1}` : `Tirar a página ${it.indice + 1}`}>{it.removida ? <Undo2 className="w-4 h-4" aria-hidden /> : <Trash2 className="w-4 h-4" aria-hidden />}</button>
                    <button type="button" className={btn} onClick={() => mover(pos, 1)} disabled={pos === itens.length - 1} aria-label={`Passar a página ${it.indice + 1} para depois`}><ChevronRight className="w-4 h-4" aria-hidden /></button>
                  </div>
                  <label className="flex items-center gap-1.5 text-mac-caption text-(--text-secondary) cursor-pointer">
                    <Checkbox checked={it.marcada} disabled={it.removida} onChange={(e) => mudar(pos, (x) => ({ ...x, marcada: e.target.checked }))} />Extrair
                  </label>
                </li>
              ))}
            </ol>
            {marcadas.length > 0 && (
              <div className="max-w-sm"><Input label="Nome do documento extraído (opcional)" value={nome} maxLength={200} onChange={(e) => setNome(e.target.value)} placeholder={`${docName.replace(/\.pdf$/i, "")} (páginas extraídas)`} /></div>
            )}
          </div>
        )}
    </Dialog>
  );
}
