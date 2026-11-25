import type { ReactElement } from "react";

/**
 * Código de barras Code-128 (conjunto C, só dígitos) — o da chave de acesso de
 * 44 dígitos do DANFE (achado A5-52: antes era um desenho aleatório). Gera SVG
 * nítido em qualquer tamanho e na impressão.
 */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
];
const STOP = "2331112";
const START_C = 105;

export function code128cBars(digits: string): number[] {
  const clean = digits.replace(/\D/g, "");
  const even = clean.length % 2 ? `0${clean}` : clean;
  const values = [START_C];
  for (let i = 0; i < even.length; i += 2) values.push(Number(even.slice(i, i + 2)));
  let sum = START_C;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  const widths: number[] = [];
  for (const v of values) for (const ch of PATTERNS[v]) widths.push(Number(ch));
  for (const ch of STOP) widths.push(Number(ch));
  return widths;
}

export default function Code128({ value, height = 44, label }: { value: string; height?: number; label: string }) {
  const widths = code128cBars(value);
  const quiet = 10;
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  let x = quiet;
  const rects: ReactElement[] = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) rects.push(<rect key={i} x={x} y={0} width={w} height={height} />);
    x += w;
  });
  return (
    <svg viewBox={`0 0 ${total} ${height}`} preserveAspectRatio="none" role="img" aria-label={label} className="w-full" style={{ height }}>
      <g fill="#000">{rects}</g>
    </svg>
  );
}
