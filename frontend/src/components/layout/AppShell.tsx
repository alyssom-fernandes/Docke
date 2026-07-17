import { ReactNode, useRef, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import TopBar from "./TopBar";
import Dock from "./Dock";
import Footer from "./Footer";
import CommandPalette from "@/components/shared/CommandPalette";
import ErrorBoundary from "@/components/shared/ErrorBoundary";
import BottomTabBar from "./BottomTabBar";

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  // Mede a largura REAL reservada pela barra de rolagem (não necessariamente
  // igual ao width:7px do ::-webkit-scrollbar em tokens.css — varia com
  // DPI/zoom do navegador) via um probe real, e expõe como --sbw pra
  // .scroll-compensate compensar exatamente o que <main> perde de largura em
  // relação à TopBar/Dock (fixed, fora do fluxo de scroll).
  useEffect(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;";
    document.body.appendChild(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    document.body.removeChild(probe);
    document.documentElement.style.setProperty("--sbw", `${width}px`);
  }, []);

  // .scroll-compensate só entra quando <main> TEM de fato barra de rolagem —
  // páginas como Documentos gerenciam o próprio scroll interno e nunca deixam
  // <main> transbordar, então aplicar a compensação ali faria o conteúdo
  // ultrapassar a TopBar em vez de bater com ela (o problema oposto).
  // ResizeObserver nos filhos diretos (não no próprio <main>, que tem altura
  // fixa via h-full e nunca muda de caixa) pega tanto troca de rota quanto
  // conteúdo assíncrono que cresce depois do mount (ex: lista carregando).
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    function check() {
      el!.classList.toggle("scroll-compensate", el!.scrollHeight > el!.clientHeight + 1);
    }
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    Array.from(el.children).forEach((child) => ro.observe(child));
    window.addEventListener("resize", check);
    return () => { ro.disconnect(); window.removeEventListener("resize", check); };
  }, [location.pathname]);

  return (
    <div className="h-screen overflow-hidden relative" style={{ background: 'var(--wallpaper)' }}>
      {/* TopBar flutua fixa sobre o conteúdo — mesmo comportamento do Dock,
          não mais um bloco em fluxo normal acima do <main> */}
      <TopBar onUploadClick={() => navigate("/documents")} />

      {/* pt: espaço pra TopBar fixa (56px + respiro). pb: espaço pro Dock/barra inferior flutuantes */}
      <main
        ref={mainRef}
        className="h-full overlay-scroll px-3 md:px-5 pt-[84px] md:pt-[92px] pb-28 md:pb-8 lg:pb-28 flex flex-col"
      >
        <ErrorBoundary key={location.pathname}>
          {/* Só padding vertical aqui — o horizontal já vem do px-3/md:px-5 do
              <main>, que é exatamente o mesmo inset da TopBar/Dock. Isso é o
              que faz o conteúdo (tabelas, cards) alinhar com a borda da
              TopBar em vez de ficar mais estreito que ela.
              flex-1: quando o conteúdo é curto (Busca vazia, Segurança,
              Preferências), empurra o Footer pro fim da viewport em vez de
              deixá-lo grudado logo depois do conteúdo, no meio da tela. */}
          <div className="page-enter py-6 flex-1">
            {children}
          </div>
        </ErrorBoundary>
        <Footer />
      </main>

      {/* Navegação inferior: barra mobile (<md) ou dock flutuante desktop (lg+) */}
      <BottomTabBar />
      <Dock />

      <CommandPalette />
    </div>
  );
}
