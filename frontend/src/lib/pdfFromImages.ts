/**
 * Monta um PDF a partir de imagens JPEG (uma por página), sem biblioteca:
 * cada página é uma imagem com DCTDecode ocupando a página inteira. Usado na
 * captura pela câmera (B1.1.7): as fotos viram um único PDF que entra pelo
 * envio normal (e passa pelo OCR do servidor).
 */
export interface JpegPage { bytes: Uint8Array; width: number; height: number }

export function pdfFromJpegs(pages: JpegPage[]): Uint8Array {
  const enc = new TextEncoder();
  const partes: Uint8Array[] = [];
  const offsets: number[] = [];
  let tamanho = 0;
  const push = (u: Uint8Array) => { partes.push(u); tamanho += u.length; };
  const txt = (s: string) => push(enc.encode(s));

  txt("%PDF-1.4\n%âãÏÓ\n");
  const total = 2 + pages.length * 3;
  const objeto = (n: number) => { offsets[n] = tamanho; };

  objeto(1);
  txt("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  objeto(2);
  txt(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((p, i) => {
    const pageN = 3 + i * 3, imgN = pageN + 1, contN = pageN + 2;
    // Largura de A4 (595 pt) mantendo a proporção da foto.
    const w = 595;
    const h = Math.round((595 * p.height) / p.width);
    objeto(pageN);
    txt(`${pageN} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contN} 0 R >>\nendobj\n`);
    objeto(imgN);
    txt(`${imgN} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
    push(p.bytes);
    txt("\nendstream\nendobj\n");
    const conteudo = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    objeto(contN);
    txt(`${contN} 0 obj\n<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream\nendobj\n`);
  });

  const xref = tamanho;
  let tabela = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) tabela += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  txt(tabela);
  txt(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(tamanho);
  let pos = 0;
  for (const u of partes) { out.set(u, pos); pos += u.length; }
  return out;
}

/** Desenha a foto girada (0, 90, 180, 270) e reduzida, e devolve o JPEG. */
export async function fotoParaJpeg(file: Blob, giro: number, realcar: boolean, maxLado = 2000): Promise<JpegPage> {
  const bmp = await createImageBitmap(file);
  const escala = Math.min(1, maxLado / Math.max(bmp.width, bmp.height));
  const bw = Math.round(bmp.width * escala), bh = Math.round(bmp.height * escala);
  const deitado = giro % 180 !== 0;
  const canvas = document.createElement("canvas");
  canvas.width = deitado ? bh : bw;
  canvas.height = deitado ? bw : bh;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (realcar && "filter" in ctx) ctx.filter = "grayscale(1) contrast(1.35) brightness(1.08)";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((giro * Math.PI) / 180);
  ctx.drawImage(bmp, -bw / 2, -bh / 2, bw, bh);
  bmp.close?.();
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Falha ao gerar a imagem."))), "image/jpeg", 0.85));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
}
