#!/usr/bin/env bash
# Backup dos dados do banco do Docke (achado X2-05 da avaliação de 25/11/2026).
#
# Uso: backup_db.sh <DATABASE_URL> <pasta_de_saida>
#
# Gera, na pasta de saída:
#   docke-db-<AAAAMMDD-HHMM>.sql.gz         dados (só dados) do schema public e das
#                                           contas em auth.users e auth.identities
#   docke-db-<AAAAMMDD-HHMM>.contagens.txt  linhas por tabela, para conferir a restauração
#
# O esquema não entra: ele vem das migrations do repositório (supabase db push).
# A restauração é feita por restore_db.sh num banco com as migrations aplicadas.
set -euo pipefail

DB_URL="${1:?informe a DATABASE_URL}"
OUT="${2:?informe a pasta de saída}"
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%d-%H%M)"
BASE="$OUT/docke-db-$STAMP"

{
  echo "-- Backup Docke $STAMP UTC (somente dados)"
  pg_dump "$DB_URL" --data-only --no-owner --no-privileges --schema=public
  pg_dump "$DB_URL" --data-only --no-owner --no-privileges --table=auth.users --table=auth.identities
} | gzip -9 > "$BASE.sql.gz"

# Linhas por tabela (partições incluídas; a view materializada fica de fora).
psql "$DB_URL" -At -v ON_ERROR_STOP=1 -c "
  SELECT format('SELECT %L || '' '' || count(*) FROM %s;', n.nspname || '.' || c.relname, c.oid::regclass)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND (n.nspname = 'public' OR (n.nspname = 'auth' AND c.relname IN ('users', 'identities')))
  ORDER BY 1" | psql "$DB_URL" -At -v ON_ERROR_STOP=1 > "$BASE.contagens.txt"

echo "Backup gerado: $BASE.sql.gz ($(du -h "$BASE.sql.gz" | cut -f1)), $(wc -l < "$BASE.contagens.txt") tabelas contadas."
