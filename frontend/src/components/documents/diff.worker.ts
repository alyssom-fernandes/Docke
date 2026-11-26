/// <reference lib="webworker" />
import { computeDiff } from "@/lib/diff";

// Comparação fora da thread principal (A5-76): texto grande não trava a aba.
self.onmessage = (e: MessageEvent<{ a: string; b: string }>) => {
  (self as unknown as Worker).postMessage(computeDiff(e.data.a, e.data.b));
};
