import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Search } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";

/** Página inexistente. `standalone` = fora do app (visitante sem sessão),
 * com fundo próprio; dentro do AppShell herda o layout do app e oferece busca. */
export default function NotFound({ standalone = false }: { standalone?: boolean }) {
  usePageTitle("Página não encontrada");
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const canGoBack = typeof window !== "undefined" && window.history.length > 1;

  function search(e: FormEvent) {
    e.preventDefault();
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
  }

  const body = (
    <div className="reveal mx-auto flex w-full max-w-[480px] flex-col items-start px-6 py-16">
      {standalone && <div className="brand-wordmark mb-10 block h-[36px] w-[124px]" role="img" aria-label="Docke" />}
      <p className="text-mac-footnote font-semibold uppercase tracking-[0.06em] text-(--text-secondary)">Erro 404</p>
      <h1 className="mt-1 text-mac-large font-bold tracking-[-0.02em] text-(--text-primary)">Esta página não existe.</h1>
      <p className="mt-2 text-mac-callout leading-[21px] text-(--text-secondary)">
        O endereço <code className="font-mono text-[12.5px] text-(--text-primary) break-all">{pathname}</code> pode ter sido digitado errado ou o link mudou de lugar.
      </p>
      {!standalone && (
        <form onSubmit={search} role="search" className="mt-6 flex w-full gap-2">
          <label htmlFor="nf-busca" className="sr-only">Procurar um documento</label>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-(--text-tertiary)" aria-hidden />
            <input
              id="nf-busca"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Procurar um documento"
              className="w-full h-10 pointer-coarse:h-11 rounded-full border border-(--border-control) bg-(--bg-card) pl-9 pr-3 text-mac-body text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
            />
          </div>
        </form>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {canGoBack && (
          <button
            onClick={() => navigate(-1)}
            className="inline-flex h-10 pointer-coarse:h-11 items-center gap-1.5 rounded-full border border-(--border-control) px-5 text-mac-body font-medium text-(--text-primary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden /> Voltar
          </button>
        )}
        <Link
          to={standalone ? "/login" : "/dashboard"}
          className="inline-flex h-10 pointer-coarse:h-11 items-center rounded-full bg-teal-600 px-5 text-mac-body font-medium text-white hover:bg-teal-700 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) focus-visible:ring-offset-1"
        >
          {standalone ? "Entrar no Docke" : "Ir para o início"}
        </Link>
      </div>
    </div>
  );

  if (!standalone) return <div className="flex min-h-[60vh] items-center">{body}</div>;
  return (
    <main className="flex min-h-screen items-center justify-center" style={{ background: "var(--wallpaper)" }}>
      {body}
    </main>
  );
}
