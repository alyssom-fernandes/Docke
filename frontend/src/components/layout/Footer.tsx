const monoBold = { fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 } as const;

export default function Footer() {
  return (
    <footer className="mt-6 pt-5 border-t border-[var(--border-default)] flex items-baseline justify-center gap-2.5">
      <div className="flex items-baseline">
        <span
          style={{ ...monoBold, letterSpacing: "2px", fontSize: "10px", color: "var(--afn-brand)", WebkitTextStroke: "0.3px var(--afn-brand-stroke)" }}
        >
          AFN
        </span>
        <span className="inline-block w-1" />
        <span style={{ ...monoBold, letterSpacing: "2px", fontSize: "10px", color: "var(--afn-muted)" }}>
          SYSTEMS
        </span>
      </div>
      <span style={{ ...monoBold, fontSize: "13px", color: "var(--afn-muted)" }}>|</span>
      <span style={{ ...monoBold, letterSpacing: "0.3px", fontSize: "11px", color: "var(--afn-muted)" }}>
        Docke
      </span>
    </footer>
  );
}
