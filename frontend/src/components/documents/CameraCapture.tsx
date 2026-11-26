import { useEffect, useRef, useState } from "react";
import { Camera, ChevronLeft, ChevronRight, RotateCw, Trash2, FileText } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";
import { fotoParaJpeg, pdfFromJpegs } from "@/lib/pdfFromImages";

interface Pagina { id: string; file: File; url: string; giro: number }

/**
 * Captura pela câmera (B1.1.7, B4.5.2): fotografar várias páginas, girar,
 * reordenar e juntar num PDF que entra pelo envio normal (o servidor lê o
 * texto). No computador, o mesmo botão abre a escolha de imagens.
 */
export default function CameraCapture({ onClose, onReady }: { onClose: () => void; onReady: (file: File) => void }) {
  const [paginas, setPaginas] = useState<Pagina[]>([]);
  const [nome, setNome] = useState(() => `Documento digitalizado ${new Date().toLocaleDateString("pt-BR").replace(/\//g, "-")}`);
  const [realcar, setRealcar] = useState(true);
  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { paginas.forEach((p) => URL.revokeObjectURL(p.url)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function adicionar(lista: FileList | null) {
    if (!lista) return;
    const novas = Array.from(lista).filter((f) => f.type.startsWith("image/")).map((file) => ({ id: `${file.name}-${file.size}-${Math.random()}`, file, url: URL.createObjectURL(file), giro: 0 }));
    setPaginas((ps) => [...ps, ...novas]);
  }
  function mover(i: number, d: number) {
    setPaginas((ps) => { const n = [...ps]; const j = i + d; if (j < 0 || j >= n.length) return ps; [n[i], n[j]] = [n[j], n[i]]; return n; });
  }
  function girar(i: number) { setPaginas((ps) => ps.map((p, k) => (k === i ? { ...p, giro: (p.giro + 90) % 360 } : p))); }
  function tirar(i: number) { setPaginas((ps) => { URL.revokeObjectURL(ps[i].url); return ps.filter((_, k) => k !== i); }); }

  async function gerar() {
    if (!paginas.length) return;
    setGerando(true);
    setErro(null);
    try {
      const jpegs = [];
      for (const p of paginas) jpegs.push(await fotoParaJpeg(p.file, p.giro, realcar));
      const pdf = pdfFromJpegs(jpegs);
      const limpo = (nome.trim() || "Documento digitalizado").replace(/[\\/:*?"<>|]+/g, "-");
      onReady(new File([pdf.buffer as ArrayBuffer], `${limpo}.pdf`, { type: "application/pdf" }));
      onClose();
    } catch {
      setErro("Não foi possível montar o PDF neste aparelho. Envie as fotos como imagens.");
    } finally {
      setGerando(false);
    }
  }

  return (
    <Dialog onClose={onClose} title="Digitalizar com a câmera" size="md" busy={gerando}
      description="Fotografe cada página com o documento bem iluminado e enquadrado. Gire e reordene antes de juntar num PDF."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={gerando} disabled={!paginas.length} onClick={gerar}><FileText className="w-4 h-4" aria-hidden /> Juntar {paginas.length > 1 ? `${paginas.length} páginas` : ""} em PDF</Button></>}>
      <div className="space-y-3">
        <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { adicionar(e.target.files); e.target.value = ""; }} />
        <Button variant="secondary" onClick={() => inputRef.current?.click()}><Camera className="w-4 h-4" aria-hidden /> {paginas.length ? "Fotografar mais uma página" : "Fotografar a primeira página"}</Button>
        {paginas.length > 0 && (
          <ol className="grid grid-cols-2 sm:grid-cols-3 gap-2" aria-label="Páginas">
            {paginas.map((p, i) => (
              <li key={p.id} className="rounded-(--radius-control) border border-(--border-default) p-1.5 space-y-1">
                <div className="aspect-[3/4] overflow-hidden rounded-[6px] bg-(--bg-hover) flex items-center justify-center">
                  <img src={p.url} alt={`Página ${i + 1}`} style={{ transform: `rotate(${p.giro}deg)` }} className={`max-w-full max-h-full object-contain transition-transform ${realcar ? "grayscale contrast-125" : ""}`} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-mac-caption text-(--text-secondary) pl-1">{i + 1}</span>
                  <div className="flex">
                    <button type="button" aria-label={`Mover a página ${i + 1} para antes`} disabled={i === 0} onClick={() => mover(i, -1)} className="p-1.5 pointer-coarse:p-2.5 rounded-full hover:bg-(--bg-hover) disabled:opacity-40"><ChevronLeft className="w-3.5 h-3.5" aria-hidden /></button>
                    <button type="button" aria-label={`Girar a página ${i + 1}`} onClick={() => girar(i)} className="p-1.5 pointer-coarse:p-2.5 rounded-full hover:bg-(--bg-hover)"><RotateCw className="w-3.5 h-3.5" aria-hidden /></button>
                    <button type="button" aria-label={`Mover a página ${i + 1} para depois`} disabled={i === paginas.length - 1} onClick={() => mover(i, 1)} className="p-1.5 pointer-coarse:p-2.5 rounded-full hover:bg-(--bg-hover) disabled:opacity-40"><ChevronRight className="w-3.5 h-3.5" aria-hidden /></button>
                    <button type="button" aria-label={`Tirar a página ${i + 1}`} onClick={() => tirar(i)} className="p-1.5 pointer-coarse:p-2.5 rounded-full hover:bg-(--bg-hover)"><Trash2 className="w-3.5 h-3.5 text-(--text-danger)" aria-hidden /></button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        <label className="flex items-center gap-2 text-mac-body text-(--text-primary)">
          <Checkbox checked={realcar} onChange={(e) => setRealcar(e.target.checked)} /> Realçar como documento (preto e branco, mais contraste)
        </label>
        <Input label="Nome do PDF" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={120} />
        {erro && <p role="alert" className="text-mac-caption text-(--text-danger)">{erro}</p>}
      </div>
    </Dialog>
  );
}
