/*
 * Passkey (WebAuthn) no navegador: B4.5.8 e B4.2.3. Converte os dados do
 * servidor (base64url) para o formato que navigator.credentials espera e a
 * resposta do aparelho de volta para base64url.
 */
import api from "@/lib/api";

const paraBytes = (s: string): ArrayBuffer => {
  const p = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
const paraTexto = (b: ArrayBuffer): string => {
  let s = "";
  new Uint8Array(b).forEach((c) => { s += String.fromCharCode(c); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const passkeySuportada = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

export async function cadastrarPasskey(nome: string) {
  const { data: op } = await api.post("/auth/passkeys/register/options");
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...op,
      challenge: paraBytes(op.challenge),
      user: { ...op.user, id: paraBytes(op.user.id) },
      excludeCredentials: (op.excludeCredentials ?? []).map((c: { id: string; type: "public-key" }) => ({ ...c, id: paraBytes(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("cancelado");
  const r = cred.response as AuthenticatorAttestationResponse;
  await api.post("/auth/passkeys/register", {
    id: cred.id, clientDataJSON: paraTexto(r.clientDataJSON), attestationObject: paraTexto(r.attestationObject), name: nome,
  });
}

/** Faz o login com a passkey e devolve a sessão (mesmo formato do login por senha). */
export async function entrarComPasskey() {
  const { data: op } = await api.post("/auth/passkeys/login/options");
  const cred = (await navigator.credentials.get({
    publicKey: { challenge: paraBytes(op.challenge), rpId: op.rpId, userVerification: "required", timeout: op.timeout },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("cancelado");
  const r = cred.response as AuthenticatorAssertionResponse;
  const { data } = await api.post("/auth/passkeys/login", {
    id: cred.id, clientDataJSON: paraTexto(r.clientDataJSON), authenticatorData: paraTexto(r.authenticatorData), signature: paraTexto(r.signature),
  });
  return data;
}
