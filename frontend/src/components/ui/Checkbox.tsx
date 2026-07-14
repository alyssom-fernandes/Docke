import { InputHTMLAttributes } from "react";

type CheckboxProps = InputHTMLAttributes<HTMLInputElement>;

export default function Checkbox({ className = "", ...props }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className={`w-4 h-4 rounded accent-teal-500 cursor-pointer ${className}`}
      {...props}
    />
  );
}
