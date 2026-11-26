import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import api from "@/lib/api";
import { relativeDate, fullDate } from "@/lib/date";

interface Access { id: string; accessed_at: string; success: boolean; user_agent: string | null; share_id: string; share_revoked: boolean }

/** "Chrome no Android", sem expor o texto cru do navegador. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "navegador não informado";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /WhatsApp/i.test(ua) ? "WhatsApp" : "navegador";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iPhone/iPad" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} no ${os}` : browser;
}

/**
 * Acessos pelos links públicos do documento, na linha do tempo dele (A5-25):
 * quando, se a senha/validade passou e o navegador. O IP fica só como hash
 * no servidor e nunca aparece.
 */
export default function LinkAccesses({ documentId }: { documentId: string }) {
  const [rows, setRows] = useState<Access[] | null>(null);
  useEffect(() => {
    setRows(null);
    api.get<Access[]>("/shares/by-resource/accesses", { params: { resource_type: "document", resource_id: documentId, limit: 20 } })
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRows([]));
  }, [documentId]);

  if (!rows || rows.length === 0) return null;
  return (
    <section aria-labelledby={`acessos-${documentId}`} className="mt-3">
      <h4 id={`acessos-${documentId}`} className="mb-1.5 flex items-center gap-1.5 text-mac-caption font-semibold text-(--text-secondary)">
        <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Aberto por link ({rows.length}{rows.length === 20 ? "+" : ""})
      </h4>
      <ul className="space-y-1">
        {rows.map((a) => (
          <li key={a.id} className="flex items-baseline justify-between gap-2 text-mac-caption">
            <span className={a.success ? "text-(--text-primary)" : "text-(--text-warning)"}>
              {a.success ? "Abriu" : "Tentou abrir (senha errada ou link vencido)"} · {describeAgent(a.user_agent)}{a.share_revoked ? " · link já revogado" : ""}
            </span>
            <time dateTime={a.accessed_at} title={fullDate(a.accessed_at)} className="shrink-0 text-(--text-secondary)">{relativeDate(a.accessed_at)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
