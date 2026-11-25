#!/usr/bin/env bash
# Ensaio de backup e restauração (roda no CI a cada PR, contra o Supabase local):
# semeia dados, faz o backup, bagunça o banco, restaura e confere contagens,
# a cadeia de hash da trilha e que o que entrou depois do backup sumiu.
# Uso: ensaio.sh <DATABASE_URL_local>
set -euo pipefail
DB_URL="${1:?informe a DATABASE_URL local}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CO=11111111-1111-4111-8111-111111111111
US=22222222-2222-4222-8222-222222222222
FO=33333333-3333-4333-8333-333333333333

psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO auth.users (id, email) VALUES ('$US', 'ensaio@backup.local');
INSERT INTO public.companies (id, name) VALUES ('$CO', 'Empresa do Ensaio de Backup');
INSERT INTO public.users (id, username, full_name, role) VALUES ('$US', 'ensaio_backup', 'Ensaio Backup', 'usuario');
INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ('$US', '$CO', 'admin');
INSERT INTO public.folders (id, company_id, path, name, created_by) VALUES ('$FO', '$CO', 'ensaio', 'Fiscal', '$US');
INSERT INTO public.documents (company_id, folder_id, name, mime_type, file_type, size_bytes, storage_path, content_hash, ocr_status, ocr_text, uploaded_by)
SELECT '$CO', '$FO', 'NF ' || g || '.pdf', 'application/pdf', 'pdf', 1000 + g, 'documents/ensaio/' || g || '.pdf', md5(g::text) || md5(g::text), 'done', 'texto ' || g, '$US'
FROM generate_series(1, 25) g;
INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)
SELECT '$US', '$CO', 'upload', 'document', d.id, d.name FROM public.documents d WHERE d.company_id = '$CO' ORDER BY d.name;
INSERT INTO public.legal_holds (company_id, resource_type, resource_id, reason, created_by) VALUES ('$CO', 'folder', '$FO', 'Ensaio', '$US');
SQL

bash "$HERE/backup_db.sh" "$DB_URL" "$WORK"
DUMP="$(ls "$WORK"/*.sql.gz)"
COUNTS="$(ls "$WORK"/*.contagens.txt)"

# Depois do backup: mais dados e uma empresa a menos de documentos (simula o estrago).
psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.companies (name) VALUES ('Criada depois do backup');
UPDATE public.legal_holds SET released_at = now() WHERE company_id = '$CO';
SET session_replication_role = replica;
DELETE FROM public.documents WHERE company_id = '$CO' AND name LIKE 'NF 1%';
SQL

bash "$HERE/restore_db.sh" "$DUMP" "$DB_URL" "$COUNTS"

RESULT="$(psql "$DB_URL" -At -v ON_ERROR_STOP=1 -c "
  SELECT (SELECT count(*) FROM public.documents WHERE company_id = '$CO') || ' ' ||
         (SELECT count(*) FROM public.companies WHERE name = 'Criada depois do backup') || ' ' ||
         (SELECT bool_and(ok) FROM public.activity_log_verify_chain('$CO')) || ' ' ||
         (SELECT count(*) FROM public.legal_holds WHERE company_id = '$CO' AND released_at IS NULL)")"
echo "Depois da restauração (documentos, empresas criadas depois, trilha íntegra, holds ativos): $RESULT"
[ "$RESULT" = "25 0 t 1" ] || { echo "Ensaio de restauração FALHOU"; exit 1; }
echo "Ensaio de backup e restauração OK."
