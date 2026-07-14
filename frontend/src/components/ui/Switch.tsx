// Switch estilo macOS/iOS: trilho pílula + círculo deslizante. Usado no lugar
// de <input type="checkbox"> pra qualquer configuração booleana on/off — o
// checkbox nativo do navegador é o maior "isso não parece feito pela Apple"
// visual que existe num formulário.
export default function Switch({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[26px] w-[46px] flex-shrink-0 items-center rounded-full transition-colors duration-normal disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-card)] ${
        checked ? "bg-teal-500" : "bg-[var(--bg-hover)] border border-[var(--border-default)]"
      }`}
    >
      <span
        className={`inline-block h-[22px] w-[22px] transform rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-normal ${
          checked ? "translate-x-[22px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
