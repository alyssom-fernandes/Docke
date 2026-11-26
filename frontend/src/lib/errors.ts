/** Mensagem que orienta, em vez do erro cru (achado A4-59). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function friendlyError(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (e?.response?.status === 413) return "O arquivo passa de 200 MB. Divida ou comprima antes de enviar.";
  if (!e?.response) return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  return fallback;
}
