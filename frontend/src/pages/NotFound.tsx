import { Link } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";

/** Página inexistente. `standalone` = fora do app (visitante sem sessão),
 * com fundo próprio; dentro do AppShell herda o layout do app. */
export default function NotFound({ standalone = false }: { standalone?: boolean }) {
  usePageTitle("Página não encontrada");

  const body = (
    <div className="mx-auto flex max-w-[440px] flex-col items-start px-6 py-16">
      {standalone && <div className="brand-wordmark mb-10 block h-[36px] w-[124px]" role="img" aria-label="Docke" />}
      <h1 className="text-mac-large font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
        Esta página não existe.
      </h1>
      <p className="mt-2 text-mac-callout leading-[21px] text-[var(--text-secondary)]">
        O endereço pode ter sido digitado errado ou o link mudou de lugar.
      </p>
      <Link
        to={standalone ? "/login" : "/dashboard"}
        className="mt-6 inline-flex h-9 items-center rounded-full bg-teal-600 px-5 text-mac-body font-medium text-white hover:bg-teal-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
      >
        {standalone ? "Ir para o início" : "Voltar ao painel"}
      </Link>
    </div>
  );

  if (!standalone) return body;
  return (
    <main className="flex min-h-screen items-center justify-center" style={{ background: "var(--wallpaper)" }}>
      {body}
    </main>
  );
}
