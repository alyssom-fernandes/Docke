/**
 * Comparação de textos por linha com realce da palavra alterada (A5-72, A5-76).
 *
 * Algoritmo de Myers (O(ND)): rápido quando as versões são parecidas, que é o
 * caso de contratos e relatórios revisados. A antiga matriz LCS n×m travava a
 * aba com milhares de linhas. Roda num Web Worker (diff.worker.ts).
 */

export type OpType = "same" | "add" | "remove";
export interface Part { changed: boolean; text: string }
export interface DiffLine { type: OpType; text: string; parts?: Part[] }

function myers<T>(a: T[], b: T[], maxD: number): { type: OpType; a?: T; b?: T }[] | null {
  const n = a.length, m = b.length, max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);
  for (let d = 0; d <= limit; d++) {
    // Guarda só a faixa de k usada no passo d (economiza memória).
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return null;
}

function backtrack<T>(trace: Int32Array[], a: T[], b: T[]) {
  const ops: { type: OpType; a?: T; b?: T }[] = [];
  let x = a.length, y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const get = (k: number) => vd[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ type: "same", a: a[x - 1], b: b[y - 1] }); x--; y--; }
    if (d > 0) {
      if (x === prevX) { ops.push({ type: "add", b: b[y - 1] }); y--; }
      else { ops.push({ type: "remove", a: a[x - 1] }); x--; }
    }
  }
  return ops.reverse();
}

// Palavras e separadores (inclui "|" do SPED, "=" e "_"), para o realce cair no valor que mudou.
const tokens = (s: string) => s.split(/(\s+|[.,;:()/\\|=_<>"'-])/).filter((t) => t !== "");

/** Realce por palavra entre a linha que saiu e a que entrou no lugar. */
function wordParts(oldLine: string, newLine: string): [Part[], Part[]] | null {
  const ta = tokens(oldLine), tb = tokens(newLine);
  if (ta.length * tb.length > 40_000) return null;
  const ops = myers(ta, tb, 120);
  if (!ops) return null;
  const pa: Part[] = [], pb: Part[] = [];
  const push = (arr: Part[], changed: boolean, text: string) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text; else arr.push({ changed, text });
  };
  for (const op of ops) {
    if (op.type === "same") { push(pa, false, op.a!); push(pb, false, op.b!); }
    else if (op.type === "remove") push(pa, true, op.a!);
    else push(pb, true, op.b!);
  }
  // Se quase tudo mudou, o realce por palavra só polui: fica a linha inteira.
  const changedShare = pb.filter((p) => p.changed).reduce((s, p) => s + p.text.length, 0) / Math.max(1, newLine.length);
  return changedShare > 0.7 ? null : [pa, pb];
}

function similarity(x: string, y: string): number {
  const a = new Set(tokens(x.toLowerCase()).filter((t) => t.trim()));
  const b = new Set(tokens(y.toLowerCase()).filter((t) => t.trim()));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / Math.max(a.size, b.size);
}

export interface DiffResult { lines: DiffLine[] | null; added: number; removed: number; changed: number }

export function computeDiff(oldText: string, newText: string): DiffResult {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  const ops = myers(a, b, 6000);
  if (!ops) return { lines: null, added: 0, removed: 0, changed: 0 };
  const lines: DiffLine[] = [];
  let added = 0, removed = 0, changed = 0;
  for (let i = 0; i < ops.length; ) {
    if (ops[i].type === "same") { lines.push({ type: "same", text: ops[i].a! }); i++; continue; }
    // Bloco de mudanças: as que saíram e as que entraram, pareadas por posição.
    const rem: string[] = [], add: string[] = [];
    while (i < ops.length && ops[i].type !== "same") {
      if (ops[i].type === "remove") rem.push(ops[i].a!); else add.push(ops[i].b!);
      i++;
    }
    const remLines: DiffLine[] = rem.map((t) => ({ type: "remove", text: t }));
    const addLines: DiffLine[] = add.map((t) => ({ type: "add", text: t }));
    // Cada linha nova é pareada com a removida mais parecida (em ordem), para
    // "prazo de 30 dias" → "prazo de 45 dias" virar uma alteração, não saída+entrada.
    let pairs = 0, from = 0;
    for (let j = 0; j < add.length && from < rem.length; j++) {
      let best = -1, bestScore = 0.3;
      for (let i = from; i < rem.length; i++) {
        const sc = similarity(rem[i], add[j]);
        if (sc > bestScore) { best = i; bestScore = sc; }
      }
      if (best < 0) continue;
      const wp = wordParts(rem[best], add[j]);
      if (wp) { remLines[best].parts = wp[0]; addLines[j].parts = wp[1]; }
      pairs++;
      from = best + 1;
    }
    changed += pairs;
    removed += rem.length - pairs;
    added += add.length - pairs;
    lines.push(...remLines, ...addLines);
  }
  return { lines, added, removed, changed };
}

/** Texto da comparação para baixar (A5-75): "+ " entrou, "- " saiu. */
export function diffToText(lines: DiffLine[], header: string): string {
  return [header, "", ...lines.map((l) => (l.type === "add" ? "+ " : l.type === "remove" ? "- " : "  ") + l.text)].join("\n");
}
