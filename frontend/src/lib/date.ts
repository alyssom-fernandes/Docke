const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  // Datas futuras (ex.: expiração de um link) — "em X dias" em vez de cair
  // incorretamente em "agora" (diff negativo é sempre < MINUTE).
  if (diff < 0) {
    const future = -diff;
    if (future < HOUR) return `em ${Math.max(1, Math.floor(future / MINUTE))} min`;
    if (future < DAY) return `em ${Math.floor(future / HOUR)}h`;
    if (future < 2 * DAY) return "amanhã";
    if (future < 30 * DAY) return `em ${Math.floor(future / DAY)} dias`;
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  }
  if (diff < MINUTE) return "agora";
  if (diff < HOUR) return `há ${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `há ${Math.floor(diff / HOUR)}h`;
  if (diff < 2 * DAY) return "ontem";
  if (diff < 7 * DAY) return `há ${Math.floor(diff / DAY)} dias`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Rótulo de cabeçalho de grupo (estilo Central de Notificações/Atividade da
 * Apple: "Hoje"/"Ontem"/"Esta semana"/mês) — usado pra agrupar listas de
 * eventos por data em vez de repetir o carimbo relativo em cada linha. */
export function dateGroupLabel(iso: string): string {
  const now = new Date();
  const d = new Date(iso);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Ontem";
  if (diffDays > 1 && diffDays < 7) return "Esta semana";
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("pt-BR", { month: "long" });
  return d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}
