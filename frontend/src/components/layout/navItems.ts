import { useEffect, useState, type ElementType } from "react";
import { LayoutDashboard, FolderOpen, Search, Anchor, Link2, Activity, CalendarClock, Trash2, Settings } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";

/**
 * Uma lista só para as três navegações (Dock, barra inferior, ⌘K): mesmos
 * nomes e ícones para o mesmo destino (A2-18, A2-50). Obrigações com
 * calendário em vez do escudo com interrogação (A2-46).
 */
export interface NavItem { to: string; icon: ElementType; label: string; match: string }

export const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Início", match: "/dashboard" },
  { to: "/documents", icon: FolderOpen, label: "Documentos", match: "/documents" },
  { to: "/search", icon: Search, label: "Busca", match: "/search" },
  { to: "/favorites", icon: Anchor, label: "Ancorados", match: "/favorites" },
  { to: "/shares", icon: Link2, label: "Links", match: "/shares" },
  { to: "/activity", icon: Activity, label: "Atividade", match: "/activity" },
  { to: "/obligations", icon: CalendarClock, label: "Obrigações", match: "/obligations" },
  { to: "/trash", icon: Trash2, label: "Lixeira", match: "/trash" },
  { to: "/settings/profile", icon: Settings, label: "Ajustes", match: "/settings" },
];

export interface NavBadge { count: number; tone: "danger" | "accent"; label: string }

const POLL_MS = 5 * 60_000;

/**
 * Avisos na navegação (A2-13): obrigações vencidas (vermelho) ou a conferir e
 * da semana (verde-azulado). Atualiza ao trocar de empresa, a cada 5 min com
 * a aba visível e quando algo muda nas obrigações (evento docke:obrigacoes).
 */
export function useNavBadges(): Record<string, NavBadge | undefined> {
  const { current } = useCompany();
  const [badges, setBadges] = useState<Record<string, NavBadge | undefined>>({});

  useEffect(() => {
    if (!current) { setBadges({}); return; }
    let alive = true;
    function load() {
      if (document.visibilityState !== "visible") return;
      api.get<Record<string, number>>(`/today/company/${current!.id}/resumo`)
        .then((r) => {
          if (!alive) return;
          const v = r.data.obrigacoes_vencidas ?? 0;
          const outras = (r.data.obrigacoes_conferir ?? 0) + (r.data.obrigacoes_semana ?? 0);
          const partes = [
            v ? `${v} ${v === 1 ? "vencida" : "vencidas"}` : "",
            r.data.obrigacoes_conferir ? `${r.data.obrigacoes_conferir} para conferir` : "",
            r.data.obrigacoes_semana ? `${r.data.obrigacoes_semana} vencendo na semana` : "",
          ].filter(Boolean).join(", ");
          setBadges({
            "/obligations": v + outras > 0 ? { count: v + outras, tone: v ? "danger" : "accent", label: partes } : undefined,
          });
        })
        .catch(() => { /* sem contador é melhor que contador errado */ });
    }
    load();
    const id = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    window.addEventListener("docke:obrigacoes", load);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener("docke:obrigacoes", load);
    };
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return badges;
}
