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

const EXT_MAP: Record<string, FileStyle> = {
  pdf:  { icon: FileType, iconColor: "text-red-600 dark:text-red-400",     bgColor: "bg-red-50 dark:bg-red-900/30" },
  xlsx: { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "bg-emerald-50 dark:bg-emerald-900/30" },
  xls:  { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "bg-emerald-50 dark:bg-emerald-900/30" },
  csv:  { icon: Sheet,    iconColor: "text-emerald-600 dark:text-emerald-400", bgColor: "bg-emerald-50 dark:bg-emerald-900/30" },
  docx: { icon: FileText, iconColor: "text-blue-600 dark:text-blue-400",    bgColor: "bg-blue-50 dark:bg-blue-900/30" },
  doc:  { icon: FileText, iconColor: "text-blue-600 dark:text-blue-400",    bgColor: "bg-blue-50 dark:bg-blue-900/30" },
  xml:  { icon: FileCode, iconColor: "text-violet-600 dark:text-violet-400", bgColor: "bg-violet-50 dark:bg-violet-900/30" },
  jpg:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "bg-amber-50 dark:bg-amber-900/30" },
  jpeg: { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "bg-amber-50 dark:bg-amber-900/30" },
  png:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "bg-amber-50 dark:bg-amber-900/30" },
  gif:  { icon: Image,    iconColor: "text-amber-600 dark:text-amber-400",  bgColor: "bg-amber-50 dark:bg-amber-900/30" },
  txt:  { icon: FileText, iconColor: "text-gray-600 dark:text-gray-400",   bgColor: "bg-gray-50 dark:bg-gray-800/30" },
};

const DEFAULT: FileStyle = {
  icon: File,
  iconColor: "text-gray-500 dark:text-gray-400",
  bgColor: "bg-gray-50 dark:bg-gray-800/30",
};

export function getFileStyle(filename: string): FileStyle {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? DEFAULT;
}
