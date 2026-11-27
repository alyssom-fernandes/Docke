/**
 * Marca d'água discreta por cima da prévia (texto repetido em diagonal). Na
 * prévia interna leva o nome de quem abriu e a data; no link público (B3.2.4,
 * FA-A1-07) leva o nome que o visitante informou, a data e a empresa que
 * enviou. Desestimula o print de tela, sem mexer no arquivo.
 */
/** Configuração da empresa (B2.4.7): texto extra, intensidade e onde aparece. */
export interface WatermarkConfig { texto?: string | null; intensidade?: "padrao" | "fraca" | "media" | "forte" | null; previa?: boolean | null; link?: boolean | null }

const OPACIDADE = { fraca: "opacity-[0.05]", media: "opacity-[0.09]", forte: "opacity-[0.15]" } as const;

export default function Watermark({ label, strength = "fraca" }: { label: string; strength?: "fraca" | "media" | "forte" }) {
  return (
    <div className="absolute inset-0 z-10 overflow-hidden pointer-events-none select-none" aria-hidden="true">
      <div className="absolute flex flex-wrap content-start gap-14 origin-center" style={{ inset: "-30%", transform: "rotate(-30deg)" }}>
        {Array.from({ length: 48 }).map((_, i) => (
          <span key={i} className={`text-mac-caption font-medium whitespace-nowrap text-(--text-primary) ${OPACIDADE[strength]}`}>{label}</span>
        ))}
      </div>
    </div>
  );
}
