import { useState, useCallback } from "react";
import { Anchor } from "lucide-react";

interface Props {
  isFavorited: boolean;
  onClick: () => Promise<void>;
  title?: string;
  className?: string;
}

export default function AnchorFavoriteButton({ isFavorited, onClick, title, className = "" }: Props) {
  const [animating, setAnimating] = useState(false);

  const handle = useCallback(async () => {
    if (!isFavorited) {
      setAnimating(true);
      // Remove class after animation ends so it can re-trigger
      setTimeout(() => setAnimating(false), 320);
    }
    await onClick();
  }, [isFavorited, onClick]);

  return (
    <button
      onClick={handle}
      title={title ?? (isFavorited ? "Remover favorito" : "Favoritar")}
      className={`p-1.5 rounded-[6px] transition-colors duration-fast ${
        isFavorited
          ? "text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20"
          : "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
      } ${className}`}
    >
      <Anchor
        className={`w-4 h-4 ${animating ? "anchor-drop" : ""} ${isFavorited ? "fill-current" : ""}`}
      />
    </button>
  );
}
