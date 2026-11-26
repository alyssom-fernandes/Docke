import { Component, ReactNode, createRef } from "react";
import { RefreshCw, WifiOff } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Na raiz do app (fora do AppShell): ocupa a tela toda, com fundo próprio. */
  root?: boolean;
}

interface State {
  error: Error | null;
}

const RELOAD_KEY = "docke_chunk_reload_at";

/** Arquivo do site que mudou depois de um deploy (a aba aberta pede um nome antigo). */
function isChunkError(error: Error | null): boolean {
  const msg = `${error?.name ?? ""} ${error?.message ?? ""}`;
  return /ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i.test(msg);
}

/**
 * Erro de tela (achados A1-31, A1-32, A1-33): uma falha numa página não derruba
 * o app em tela branca, a mensagem diz o que aconteceu e o que fazer, e o erro
 * mais comum — versão nova publicada com a aba aberta — se resolve sozinho com
 * uma recarga (uma vez a cada minuto, para não entrar em laço).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private headingRef = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isChunkError(error)) {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
      if (Date.now() - last > 60_000) {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        window.location.reload();
        return;
      }
    }
    // Registro mínimo no console para o suporte; sem dados do documento.
    console.error("[Docke] Erro na tela:", error?.name, error?.message);
  }

  componentDidUpdate(_: Props, prev: State) {
    if (this.state.error && !prev.error) this.headingRef.current?.focus();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunk = isChunkError(error);
    const body = (
      <div role="alert" className="reveal mx-auto flex max-w-[460px] flex-col items-start gap-3 px-6 py-16">
        <div className="w-11 h-11 rounded-full bg-amber-500/12 flex items-center justify-center">
          {chunk ? <WifiOff className="w-5 h-5 text-(--text-warning)" aria-hidden /> : <RefreshCw className="w-5 h-5 text-(--text-warning)" aria-hidden />}
        </div>
        <h1 ref={this.headingRef} tabIndex={-1} className="text-mac-title2 font-bold text-(--text-primary) focus:outline-hidden">
          {chunk ? "O Docke foi atualizado." : "Esta tela não abriu."}
        </h1>
        <p className="text-mac-callout leading-[21px] text-(--text-secondary)">
          {chunk
            ? "Recarregue a página para usar a versão nova. Nada do que já foi salvo se perde."
            : "Recarregue a página. Se continuar, volte ao início e tente o caminho de novo; o que já foi salvo continua lá."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            onClick={() => window.location.reload()}
            className="inline-flex h-9 pointer-coarse:h-11 items-center gap-2 rounded-full bg-teal-600 px-5 text-mac-body font-medium text-white hover:bg-teal-700 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) focus-visible:ring-offset-1"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden />
            Recarregar
          </button>
          <a
            href="/dashboard"
            className="inline-flex h-9 pointer-coarse:h-11 items-center rounded-full border border-(--border-control) px-5 text-mac-body font-medium text-(--text-primary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
          >
            Ir para o início
          </a>
        </div>
      </div>
    );

    if (!this.props.root) return body;
    return (
      <main className="flex min-h-screen items-center justify-center" style={{ background: "var(--wallpaper)" }}>
        {body}
      </main>
    );
  }
}
