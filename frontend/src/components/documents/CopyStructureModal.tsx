import { useEffect, useRef, useState } from "react";
import { X, Folder, Home, Loader2 } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Portal from "@/components/ui/Portal";
import Dropdown from "@/components/ui/Dropdown";
import Checkbox from "@/components/ui/Checkbox";

interface FolderOption {
  id: string;
  name: string;
  parent_id: string | null;
  depth: number;
}

// Achata a árvore vinda de /folders?flat=true em uma lista já ordenada por
// profundidade (pai sempre antes dos filhos) — usado só pra exibição no
// seletor de destino, não reaproveita FolderTree porque ele tem drag-and-drop
// próprio (mover pasta), que seria perigoso disparar sem querer aqui dentro.
function buildFlatOptions(raw: Array<{ id: string; name: string; parent_id: string | null }>): FolderOption[] {
  const byParent = new Map<string | null, typeof raw>();
  raw.forEach((f) => {
    const key = f.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(f);
  });
  const result: FolderOption[] = [];
  function walk(parentId: string | null, depth: number) {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of children) {
      result.push({ id: f.id, name: f.name, parent_id: f.parent_id, depth });
      walk(f.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

export default function CopyStructureModal({
  sourceFolderId,
  sourceFolderName,
  sourceCompanyId,
  onClose,
  onDone,
}: {
  sourceFolderId: string;
  sourceFolderName: string;
  sourceCompanyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { companies, current } = useCompany();
  const { success, error: showError } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  // Só empresas onde o usuário é admin fazem sentido como destino — criar
  // pasta exige admin (mesma regra de POST /folders), então nem oferecemos
  // as outras pra evitar erro 403 previsível.
  const targetableCompanies = companies.filter((c) => c.permission_level === "admin");

  const [targetCompanyId, setTargetCompanyId] = useState(current?.id ?? targetableCompanies[0]?.id ?? "");
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [targetParentId, setTargetParentId] = useState<string | null>(null);
  const [includeMetadata, setIncludeMetadata] = useState(false);
  const [includeDocuments, setIncludeDocuments] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!targetCompanyId) { setFolderOptions([]); return; }
    setLoadingFolders(true);
    setTargetParentId(null);
    api.get("/folders", { params: { company_id: targetCompanyId, flat: true } })
      .then((r) => setFolderOptions(buildFlatOptions(Array.isArray(r.data) ? r.data : [])))
      .catch(() => setFolderOptions([]))
      .finally(() => setLoadingFolders(false));
  }, [targetCompanyId]);

  // Copiar pra dentro da própria pasta (ou de um descendente dela) na mesma
  // empresa não faz sentido — o backend já bloqueia, mas desabilitar aqui
  // evita a viagem de ida-e-volta só pra mostrar o erro.
  const disabledFolderIds = new Set<string>();
  if (targetCompanyId === sourceCompanyId) {
    const descendantsOf = (id: string) => {
      disabledFolderIds.add(id);
      folderOptions.filter((f) => f.parent_id === id).forEach((f) => descendantsOf(f.id));
    };
    descendantsOf(sourceFolderId);
  }

  async function submit() {
    if (!targetCompanyId) return;
    setSubmitting(true);
    try {
      const { data } = await api.post(`/folders/${sourceFolderId}/copy-structure`, {
        target_company_id: targetCompanyId,
        target_parent_id: targetParentId,
        include_metadata: includeMetadata,
        include_documents: includeDocuments,
      });
      const parts = [`${data.folders_copied} pasta${data.folders_copied !== 1 ? "s" : ""}`];
      if (data.documents_copied > 0) parts.push(`${data.documents_copied} documento${data.documents_copied !== 1 ? "s" : ""}`);
      success(`Estrutura copiada: ${parts.join(", ")}.`);
      onDone();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível copiar a estrutura.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Portal>
      <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div ref={containerRef} className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[440px] max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
            <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Copiar estrutura de "{sourceFolderName}"</h2>
            <button onClick={onClose} className="p-1 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            <div>
              <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1">Empresa de destino</label>
              <Dropdown
                value={targetCompanyId}
                onChange={setTargetCompanyId}
                placeholder="Selecione a empresa"
                options={targetableCompanies.map((c) => ({ value: c.id, label: c.name }))}
              />
            </div>

            <div>
              <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1">Pasta de destino</label>
              <div className="border border-[var(--border-default)] rounded-[var(--radius-control)] max-h-[220px] overflow-y-auto bg-[var(--bg-card)]">
                {loadingFolders ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--text-placeholder)]" />
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => setTargetParentId(null)}
                      className={`w-full flex items-center gap-2 h-8 px-3 text-mac-body text-left transition-colors duration-fast ${
                        targetParentId === null ? "bg-teal-500/10 text-teal-500 font-medium" : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      }`}
                    >
                      <Home className="w-3.5 h-3.5 flex-shrink-0" />
                      Raiz da empresa
                    </button>
                    {folderOptions.map((f) => {
                      const disabled = disabledFolderIds.has(f.id);
                      return (
                        <button
                          key={f.id}
                          disabled={disabled}
                          onClick={() => setTargetParentId(f.id)}
                          style={{ paddingLeft: `${12 + f.depth * 16}px` }}
                          title={disabled ? "Não é possível copiar para dentro da própria pasta" : undefined}
                          className={`w-full flex items-center gap-2 h-8 pr-3 text-mac-body text-left transition-colors duration-fast ${
                            disabled
                              ? "text-[var(--text-placeholder)] cursor-not-allowed"
                              : targetParentId === f.id
                              ? "bg-teal-500/10 text-teal-500 font-medium"
                              : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                          }`}
                        >
                          <Folder className={`w-3.5 h-3.5 flex-shrink-0 ${disabled ? "" : "text-teal-500"}`} />
                          <span className="truncate">{f.name}</span>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 text-mac-body text-[var(--text-primary)] cursor-pointer">
                <Checkbox checked={includeMetadata} onChange={(e) => setIncludeMetadata(e.target.checked)} />
                Incluir campos de metadados configurados
              </label>
              <label className="flex items-center gap-2 text-mac-body text-[var(--text-primary)] cursor-pointer">
                <Checkbox checked={includeDocuments} onChange={(e) => setIncludeDocuments(e.target.checked)} />
                Incluir documentos (pode demorar mais)
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>Cancelar</Button>
            <Button size="sm" loading={submitting} onClick={submit} disabled={!targetCompanyId}>
              Copiar
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
