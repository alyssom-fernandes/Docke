import { useEffect, useState } from "react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Switch from "@/components/ui/Switch";

/*
 * Avisos no celular (B4.4.5): liga o Web Push neste aparelho. Os avisos da
 * central (prazos, pedidos, documentos novos) chegam mesmo com o app fechado.
 * No iPhone, só funciona com o Docke instalado na tela de início (iOS 16.4+).
 */

function chave(b64: string): Uint8Array<ArrayBuffer> {
  const p = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function PushPreference() {
  const { success, error: showError } = useToast();
  const [suportado] = useState(() => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
  const [publica, setPublica] = useState<string | null>(null);
  const [ligado, setLigado] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!suportado) return;
    api.get("/push/public-key").then((r) => setPublica(r.data.public_key)).catch(() => setPublica(null));
    navigator.serviceWorker.getRegistration().then((reg) => reg?.pushManager.getSubscription()).then((s) => setLigado(!!s)).catch(() => {});
  }, [suportado]);

  if (!suportado || !publica) return null;

  async function mudar(v: boolean) {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (v) {
        if ((await Notification.requestPermission()) !== "granted") {
          showError("O navegador não deu permissão para avisos. Libere nas configurações do site e tente de novo.");
          return;
        }
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave(publica!) });
        await api.post("/push/subscribe", sub.toJSON());
        setLigado(true);
        success("Avisos ligados neste aparelho.");
      } else {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api.post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
          await sub.unsubscribe();
        }
        setLigado(false);
        success("Avisos desligados neste aparelho.");
      }
    } catch (e: any) {
      showError(typeof e?.response?.data?.detail === "string" ? e.response.data.detail : "Não foi possível mudar os avisos neste aparelho.");
    } finally { setBusy(false); }
  }

  return (
    <div className="pt-6 border-t border-(--border-default)">
      <div className="flex items-center justify-between gap-4 max-w-[480px]">
        <div>
          <h3 className="text-mac-body font-medium text-(--text-primary)">Avisos neste aparelho</h3>
          <p className="text-mac-caption text-(--text-tertiary) mt-0.5">Prazos, pedidos e documentos novos chegam mesmo com o Docke fechado. No iPhone, instale o Docke na tela de início antes.</p>
        </div>
        <Switch checked={ligado} disabled={busy} onChange={mudar} label="Avisos neste aparelho" />
      </div>
    </div>
  );
}
