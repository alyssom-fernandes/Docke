import {
  FileText,
  Sheet,
  FileCode,
  Image,
  FileType,
  File,
} from "lucide-react";
import type { ElementType } from "react";

export interface FileStyle {
  icon: ElementType;
  iconColor: string;
  bgColor: string;
  /** Preenchimento translúcido do próprio glifo (classe Tailwind fill-*), pra dar
   *  leve volume ao ícone de contorno sem virar bitmap dimensional — o traço
   *  continua carregando a cor principal. */
  fillColor: string;
}

// bgColor vazio de propósito — macOS não usa "tile" colorido atrás de ícone de
// arquivo. A cor mora no traço do ícone; fillColor adiciona um preenchimento
// suave da mesma cor pra aproximar do volume dos ícones do Finder.
const EXT_MAP: Record<string, FileStyle> = {
  pdf:  { icon: FileType, iconColor: "text-red-600 dark:text-red-400",     bgColor: "", fillColor: "fill-red-500/15 dark:fill-red-400/15" },
  xlsx: { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "", fillColor: "fill-emerald-500/15 dark:fill-emerald-400/15" },
  xls:  { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "", fillColor: "fill-emerald-500/15 dark:fill-emerald-400/15" },
  csv:  { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "", fillColor: "fill-emerald-500/15 dark:fill-emerald-400/15" },
  docx: { icon: FileText, iconColor: "text-blue-600 dark:text-blue-400",    bgColor: "", fillColor: "fill-blue-500/15 dark:fill-blue-400/15" },
  doc:  { icon: FileText, iconColor: "text-blue-600 dark:text-blue-400",    bgColor: "", fillColor: "fill-blue-500/15 dark:fill-blue-400/15" },
  xml:  { icon: FileCode, iconColor: "text-violet-600 dark:text-violet-400", bgColor: "", fillColor: "fill-violet-500/15 dark:fill-violet-400/15" },
  jpg:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "", fillColor: "fill-amber-500/15 dark:fill-amber-400/15" },
  jpeg: { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "", fillColor: "fill-amber-500/15 dark:fill-amber-400/15" },
  png:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "", fillColor: "fill-amber-500/15 dark:fill-amber-400/15" },
  gif:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "", fillColor: "fill-amber-500/15 dark:fill-amber-400/15" },
  txt:  { icon: FileText, iconColor: "text-gray-600 dark:text-gray-400",   bgColor: "", fillColor: "fill-gray-500/15 dark:fill-gray-400/15" },
};

const DEFAULT: FileStyle = {
  icon: File,
  iconColor: "text-gray-500 dark:text-gray-400",
  bgColor: "",
  fillColor: "fill-gray-500/15 dark:fill-gray-400/15",
};

export function getFileStyle(filename: string): FileStyle {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? DEFAULT;
}
