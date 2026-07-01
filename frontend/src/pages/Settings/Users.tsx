import { useEffect, useState } from "react";
import { Users as UsersIcon } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/shared/EmptyState";

interface Member {
  user_id: string;
  full_name: string;
  username: string;
  role: string;
}

export default function Users() {
  usePageTitle("Usuários");
  const { current } = useCompany();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!current) return;
    setLoading(true);
    api
      .get<Member[]>(`/companies/${current.id}/members`)
      .then((r) => setMembers(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [current?.id]);

  return (
    <div className="max-w-[700px] mx-auto space-y-6">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">Usuários</h1>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] animate-pulse" />
          ))}
        </div>
      ) : members.length === 0 ? (
        <EmptyState
          title="Nenhum usuário"
          icon={<UsersIcon className="w-6 h-6" />}
        />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
          <ul>
            {members.map((m) => (
              <li
                key={m.user_id}
                className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] border-b border-[var(--border-default)] last:border-0"
              >
                <Avatar name={m.full_name} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">{m.full_name}</p>
                  <p className="text-xs text-[var(--text-secondary)] truncate">@{m.username}</p>
                </div>
                <Badge variant={m.role === "manager" ? "teal" : m.role === "editor" ? "info" : "default"}>
                  {{ viewer: "Visualizador", editor: "Editor", manager: "Gerente" }[m.role] ?? m.role}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
