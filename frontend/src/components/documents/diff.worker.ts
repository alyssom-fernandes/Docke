/// <reference lib="webworker" />
import { computeDiff, type DiffUnit } from "@/lib/diff";

// Comparação fora da thread principal (A5-76): texto grande não trava a aba.
self.onmessage = (e: MessageEvent<{ a: string; b: string; unit?: DiffUnit }>) => {
  (self as unknown as Worker).postMessage(computeDiff(e.data.a, e.data.b, e.data.unit ?? "linha"));
};
