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
}

// bgColor vazio de propósito — macOS não usa "tile" colorido atrás de ícone de
// arquivo, a cor mora só no traço do ícone (mesmo padrão do Finder).
const EXT_MAP: Record<string, FileStyle> = {
  pdf:  { icon: FileType, iconColor: "text-red-600 dark:text-red-400",     bgColor: "" },
  xlsx: { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "" },
  xls:  { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "" },
  csv:  { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "" },
  docx: { icon: FileText, iconColor: "text-blue-600 dark:text-blue-400",    bgColor: "" },
  doc:  { icon: FileText, iconColor: "text-blue-600 dark:text-blue-400",    bgColor: "" },
  xml:  { icon: FileCode, iconColor: "text-violet-600 dark:text-violet-400", bgColor: "" },
  jpg:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "" },
  jpeg: { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "" },
  png:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "" },
  gif:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "" },
  txt:  { icon: FileText, iconColor: "text-gray-600 dark:text-gray-400",   bgColor: "" },
};

const DEFAULT: FileStyle = {
  icon: File,
  iconColor: "text-gray-500 dark:text-gray-400",
  bgColor: "",
};

export function getFileStyle(filename: string): FileStyle {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? DEFAULT;
}
