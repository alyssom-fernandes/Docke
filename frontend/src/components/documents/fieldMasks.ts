/**
 * Máscara e validação dos campos de metadados no próprio formulário (achado
 * A5-11): CPF e CNPJ com dígito verificador, data e competência válidas.
 * A mesma regra continua no backend; aqui o erro aparece antes de salvar.
 */
export type FieldType = "texto" | "cpf" | "cnpj" | "data" | "competencia" | "numero" | "selecao" | "moeda" | "email" | "telefone" | "cep" | "booleano"
  | "texto_longo" | "data_hora" | "multipla" | "url";

/** Opções fixas de quem escolhe numa lista (seleção e sim/não). */
export function fieldOptions(type: string, options?: unknown): string[] {
  if (type === "booleano") return ["Sim", "Não"];
  return Array.isArray(options) ? (options as string[]) : [];
}
export const isChoice = (type: string) => type === "selecao" || type === "booleano";

const digits = (v: string) => v.replace(/\D/g, "");

export function maskValue(type: FieldType, raw: string): string {
  const d = digits(raw);
  switch (type) {
    case "cpf":
      return d.slice(0, 11).replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
    case "cnpj":
      return d.slice(0, 14).replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d{1,2})$/, "$1-$2");
    case "data":
      return d.slice(0, 8).replace(/(\d{2})(\d)/, "$1/$2").replace(/(\d{2})\/(\d{2})(\d)/, "$1/$2/$3");
    case "competencia":
      return d.slice(0, 6).replace(/(\d{2})(\d)/, "$1/$2");
    case "numero":
      return raw.replace(/[^\d,.-]/g, "");
    case "moeda":
      return raw.replace(/[^\d,.R$\s-]/g, "");
    case "telefone": {
      const t = d.slice(0, 11);
      return t.length > 10 ? t.replace(/^(\d{2})(\d{5})(\d{0,4})/, "($1) $2-$3") : t.replace(/^(\d{2})(\d{4})(\d{0,4})/, "($1) $2-$3").replace(/^(\d{2})(\d{0,4})$/, "($1) $2");
    }
    case "cep":
      return d.slice(0, 8).replace(/^(\d{5})(\d)/, "$1-$2");
    case "data_hora":
      return d.slice(0, 12).replace(/(\d{2})(\d)/, "$1/$2").replace(/(\d{2})\/(\d{2})(\d)/, "$1/$2/$3").replace(/(\d{4})(\d{2})(\d)/, "$1 $2:$3");
    default:
      return raw;
  }
}

function cpfOk(v: string): boolean {
  const d = digits(v);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(d[n])) return false;
  }
  return true;
}

function cnpjOk(v: string): boolean {
  const d = digits(v);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((acc, wi, i) => acc + wi * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** Mensagem de erro (ou null) para o valor já mascarado. Vazio não é erro aqui. */
export function validateValue(type: FieldType, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (type) {
    case "cpf":
      return cpfOk(v) ? null : "CPF inválido: confira os dígitos.";
    case "cnpj":
      return cnpjOk(v) ? null : "CNPJ inválido: confira os dígitos.";
    case "data": {
      const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!m) return "Use dd/mm/aaaa.";
      const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      return dt.getDate() === Number(m[1]) && dt.getMonth() === Number(m[2]) - 1 ? null : "Essa data não existe.";
    }
    case "competencia": {
      const m = v.match(/^(\d{2})\/(\d{4})$/);
      if (!m) return "Use mm/aaaa.";
      return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? null : "O mês vai de 01 a 12.";
    }
    case "numero":
      return /^-?\d+([.,]\d+)?$/.test(v) ? null : "Use só números, com vírgula nos centavos (ex.: 1234,56).";
    case "moeda":
      return /^-?(R\$\s?)?\d{1,3}(\.?\d{3})*(,\d{1,2})?$|^-?\d+(\.\d{1,2})?$/.test(v.replace(/\s/g, "")) ? null : "Valor em reais: use 1.234,56.";
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "E-mail inválido.";
    case "telefone":
      return [10, 11].includes(digits(v).length) ? null : "Telefone com DDD: (11) 98765-4321.";
    case "cep":
      return digits(v).length === 8 ? null : "CEP tem 8 dígitos.";
    case "data_hora": {
      const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
      if (!m) return "Use dd/mm/aaaa hh:mm.";
      return Number(m[4]) < 24 && Number(m[5]) < 60 ? null : "Hora inválida.";
    }
    case "url":
      return /^(https?:\/\/)?[^\s/$.?#][^\s]*\.[^\s]+$/i.test(v) ? null : "Endereço inválido: use site.com.br/página.";
    case "texto_longo":
      return v.length <= 2000 ? null : "Até 2.000 caracteres.";
    default:
      return null;
  }
}

export const PLACEHOLDER: Record<FieldType, string> = {
  texto: "", cpf: "000.000.000-00", cnpj: "00.000.000/0000-00", data: "dd/mm/aaaa", competencia: "mm/aaaa", numero: "0", selecao: "",
  moeda: "R$ 0,00", email: "nome@empresa.com.br", telefone: "(11) 98765-4321", cep: "00000-000", booleano: "",
  texto_longo: "", data_hora: "dd/mm/aaaa hh:mm", multipla: "", url: "https://",
};

export const INPUT_MODE: Partial<Record<FieldType, "numeric" | "decimal">> = {
  cpf: "numeric", cnpj: "numeric", data: "numeric", competencia: "numeric", numero: "decimal", moeda: "decimal", telefone: "numeric", cep: "numeric",
  data_hora: "numeric",
};
