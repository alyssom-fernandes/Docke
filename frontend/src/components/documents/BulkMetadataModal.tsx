import { useState, useId } from "react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import Dialog from "@/components/ui/Dialog";
import {
  maskValue,
  validateValue,
  PLACEHOLDER,
  INPUT_MODE,
  fieldOptions,
  isChoice,
  type FieldType,
} from "@/components/documents/fieldMasks";
import { friendlyError } from "@/lib/errors";
import { type ResolvedField, plural } from "@/components/documents/docShared";

// Fase 8.2: edição de metadados em lote — abre a partir da barra de seleção
// múltipla. Cada campo mostra "(varies)" quando os documentos selecionados
// têm valores diferentes; deixar o campo assim (sem digitar nada) preserva
// o valor de cada documento — só os campos que a pessoa realmente editar
// são enviados, um PUT por documento reaproveitando o mesmo endpoint do
// formulário individual (sem endpoint novo, sem migration).
export function BulkMetadataModal({
  documentIds, fields, fieldValues, companyId, onClose, onSaved,
}: {
  documentIds: string[]; fields: ResolvedField[]; fieldValues: Record<string, Record<string, string>>;
  companyId: string; onClose: () => void; onSaved: (applied: Record<string, string>) => void;
}) {
  const { success, error: showError } = useToast();
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const uid = useId();

  function summary(fieldId: string): { varies: boolean; common: string } {
    const distinct = new Set(documentIds.map((id) => fieldValues[id]?.[fieldId] ?? "").filter((v) => v !== ""));
    if (distinct.size === 0) return { varies: false, common: "" };
    if (distinct.size === 1) return { varies: false, common: [...distinct][0] };
    return { varies: true, common: "" };
  }

  async function save() {
    const changed = Object.entries(edited).filter(([, v]) => v.trim() !== "");
    if (!changed.length) { onClose(); return; }
    const errs: Record<string, string> = {};
    for (const [fid, v] of changed) {
      const f = fields.find((x) => x.custom_field_id === fid);
      const e = f ? validateValue(f.type as FieldType, v) : null;
      if (e) errs[fid] = e;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      await api.put("/documents/field-values/batch", {
        document_ids: documentIds,
        values: changed.map(([custom_field_id, value]) => ({ custom_field_id, value: value.trim() })),
      }, { params: { company_id: companyId } });
      success(`Metadados aplicados em ${plural(documentIds.length, "documento", "documentos")}.`);
      onSaved(Object.fromEntries(changed.map(([k, v]) => [k, v.trim()])));
      onClose();
    } catch (e: any) {
      showError(friendlyError(e, "Nada foi alterado: confira os valores e tente de novo."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      title={`Metadados de ${plural(documentIds.length, "documento", "documentos")}`}
      description="Preencha só o que quer mudar em todos. Campos em branco ficam como estão em cada documento."
      size="md"
      busy={saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button loading={saving} onClick={save} disabled={fields.length === 0 || !Object.values(edited).some((v) => v.trim())}>
            Aplicar em {documentIds.length}
          </Button>
        </>
      }
    >
      {fields.length === 0 ? (
        <p className="text-mac-body text-(--text-secondary)">Esta pasta não tem campos de metadados. Crie em Ajustes → Metadados.</p>
      ) : (
        <div className="space-y-4">
          {fields.map((f) => {
            const { varies, common } = summary(f.custom_field_id);
            const fid = `${uid}-${f.custom_field_id}`;
            const err = errors[f.custom_field_id];
            const hint = varies ? "Valores diferentes entre os documentos" : common ? `Hoje: ${common}` : "Vazio hoje";
            return (
              <div key={f.custom_field_id}>
                <label htmlFor={fid} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">
                  {f.label}{f.required && <span className="text-(--text-danger)" aria-label="obrigatório"> *</span>}
                </label>
                {isChoice(f.type) ? (
                  <Dropdown id={fid} ariaLabel={f.label} value={edited[f.custom_field_id] ?? ""} placeholder={hint}
                    onChange={(v) => setEdited((e) => ({ ...e, [f.custom_field_id]: v }))}
                    options={fieldOptions(f.type, f.format_config?.options).map((o) => ({ value: o, label: o }))} />
                ) : (
                  <input id={fid} type="text" inputMode={INPUT_MODE[f.type as FieldType]} value={edited[f.custom_field_id] ?? ""}
                    onChange={(e) => { const v = maskValue(f.type as FieldType, e.target.value); setEdited((prev) => ({ ...prev, [f.custom_field_id]: v })); setErrors((x) => { const n = { ...x }; delete n[f.custom_field_id]; return n; }); }}
                    placeholder={PLACEHOLDER[f.type as FieldType] || hint}
                    aria-invalid={err ? true : undefined} aria-describedby={`${fid}-dica`}
                    className={`w-full h-9 pointer-coarse:h-11 px-3 text-mac-body pointer-coarse:text-[16px] bg-(--bg-card) border rounded-(--radius-control) text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) ${err ? "border-red-500" : "border-(--border-control)"}`} />
                )}
                <p id={`${fid}-dica`} className={`mt-1 text-mac-caption ${err ? "text-(--text-danger)" : "text-(--text-secondary)"}`}>{err ?? hint}</p>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
