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
      className={`group relative inline-flex h-4 w-9 pointer-coarse:h-[31px] pointer-coarse:w-[51px] shrink-0 items-center rounded-full transition-colors duration-normal disabled:opacity-(--opacity-disabled) disabled:pointer-events-none focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${
        checked ? "bg-(--accent)" : "bg-(--control-fill-hover)"
      }`}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 h-[13px] w-[21px] pointer-coarse:h-[27px] pointer-coarse:w-[27px] rounded-full bg-white shadow-[0_0.5px_1.5px_rgba(0,0,0,0.25),0_3px_8px_rgba(0,0,0,0.08)] transition-[left] duration-normal ${
          checked ? "left-[13px] pointer-coarse:left-[22px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}
