/**
 * Skeletons dimensionados por variante (regra da pesquisa: altura idêntica ao
 * conteúdo real, senão o salto de layout quando o dado chega pode fazer o
 * usuário clicar no item errado). Cada variante espelha exatamente a
 * estrutura de colunas/breakpoints do componente real que ela substitui —
 * ver useDelayedLoading para o controle de quando mostrar.
 */

function Bar({ w, className = "" }: { w: string; className?: string }) {
  return (
    <div
      className={`h-3 rounded-full bg-[var(--bg-hover)] animate-pulse ${className}`}
      style={{ width: w }}
    />
  );
}

/** Linha da tabela de Documentos — mesma estrutura de <td> e breakpoints
 * hidden sm:/md: do array `items.map` real, altura ~38.8px medida ao vivo
 * (py-2 densidade padrão; adapta com a mesma prop de densidade da tabela). */
export function SkeletonTableRow({
  selectionMode,
  customFieldCount,
  compact,
}: {
  selectionMode: boolean;
  customFieldCount: number;
  compact: boolean;
}) {
  const pad = compact ? "py-1" : "py-1.5";
  // larguras variadas pra não parecer um bloco só — mimetiza nomes de arquivo reais
  const nameWidths = ["58%", "42%", "70%", "50%"];
  const idx = Math.floor(Math.random() * nameWidths.length);
  return (
    <tr className="border-b border-[var(--border-default)]">
      {selectionMode && (
        <td className={`px-4 ${pad}`}>
          <div className="w-4 h-4 rounded-[4px] bg-[var(--bg-hover)] animate-pulse" />
        </td>
      )}
      <td className={`px-3 ${pad}`}>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-[4px] bg-[var(--bg-hover)] animate-pulse flex-shrink-0" />
          <Bar w={nameWidths[idx]} />
        </div>
      </td>
      <td className={`px-3 ${pad} hidden sm:table-cell`}><Bar w="70%" /></td>
      <td className={`px-3 ${pad} hidden sm:table-cell`}><Bar w="50%" className="ml-auto" /></td>
      <td className={`px-3 ${pad} hidden sm:table-cell`}><Bar w="16px" /></td>
      <td className={`px-3 ${pad} hidden md:table-cell`}><Bar w="60%" /></td>
      {Array.from({ length: customFieldCount }).map((_, i) => (
        <td key={i} className={`px-3 ${pad} hidden sm:table-cell`}><Bar w="65%" /></td>
      ))}
      <td className="px-2 py-2" />
    </tr>
  );
}

/** Tile da view em grade — ~120x84px medido ao vivo (ícone + 1-2 linhas de nome). */
export function SkeletonGridItem() {
  return (
    <div className="flex flex-col items-center gap-1.5 py-3 px-2">
      <div className="w-8 h-8 rounded-[8px] bg-[var(--bg-hover)] animate-pulse" />
      <Bar w="70%" className="h-2.5" />
    </div>
  );
}
