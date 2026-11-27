import { createElement, type ElementType } from "react";
import { MacDocumentIcon } from "@/components/ui/MacIcons";

export interface FileStyle {
  icon: ElementType;
  iconColor: string;
  bgColor: string;
  /** Mantido por compatibilidade com quem ainda passa a classe; o ícone novo tem cores próprias. */
  fillColor: string;
}

/**
 * Ícone de documento no estilo do Finder (macOS 27): folha branca com o canto
 * dobrado e uma faixa na cor do tipo. As classes de cor antigas (iconColor,
 * fillColor) deixam de pintar o ícone: ele tem cores próprias, como no macOS.
 */
function docIcon(color: string, label: string): ElementType {
  const Icon = ({ className }: { className?: string }) => createElement(MacDocumentIcon, { className, color, label });
  Icon.displayName = `Doc${label}`;
  return Icon;
}

const RED = "#E5483B";
const GREEN = "#2FA45B";
const BLUE = "#2F7BEA";
const PURPLE = "#8E5BD9";
const ORANGE = "#E8912D";
const GRAY = "#8E8E93";

const EXT_MAP: Record<string, FileStyle> = {
  pdf:  { icon: docIcon(RED, "PDF"), iconColor: "", bgColor: "", fillColor: "" },
  xlsx: { icon: docIcon(GREEN, "XLSX"), iconColor: "", bgColor: "", fillColor: "" },
  xls:  { icon: docIcon(GREEN, "XLS"), iconColor: "", bgColor: "", fillColor: "" },
  csv:  { icon: docIcon(GREEN, "CSV"), iconColor: "", bgColor: "", fillColor: "" },
  docx: { icon: docIcon(BLUE, "DOCX"), iconColor: "", bgColor: "", fillColor: "" },
  doc:  { icon: docIcon(BLUE, "DOC"), iconColor: "", bgColor: "", fillColor: "" },
  xml:  { icon: docIcon(PURPLE, "XML"), iconColor: "", bgColor: "", fillColor: "" },
  jpg:  { icon: docIcon(ORANGE, "JPG"), iconColor: "", bgColor: "", fillColor: "" },
  jpeg: { icon: docIcon(ORANGE, "JPEG"), iconColor: "", bgColor: "", fillColor: "" },
  png:  { icon: docIcon(ORANGE, "PNG"), iconColor: "", bgColor: "", fillColor: "" },
  gif:  { icon: docIcon(ORANGE, "GIF"), iconColor: "", bgColor: "", fillColor: "" },
  txt:  { icon: docIcon(GRAY, "TXT"), iconColor: "", bgColor: "", fillColor: "" },
};

const DEFAULT: FileStyle = { icon: docIcon(GRAY, ""), iconColor: "", bgColor: "", fillColor: "" };

export function getFileStyle(filename: string): FileStyle {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? DEFAULT;
}
