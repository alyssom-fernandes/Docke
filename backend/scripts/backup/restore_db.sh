#!/usr/bin/env bash
# Restauração dos dados de um backup gerado por backup_db.sh.
#
# Uso: restore_db.sh <arquivo.sql.gz> <DATABASE_URL_destino> [arquivo.contagens.txt]
#
# O destino precisa ter o mesmo esquema (as migrations do repositório aplicadas,
# por exemplo um projeto Supabase novo depois de `supabase db push`). Os dados
# atuais das tabelas do schema public e das contas (auth.users) são APAGADOS
# antes da carga, tudo numa única transação: se algo falhar, nada muda.
# Com o arquivo de contagens, confere tabela por tabela no fim.
set -euo pipefail

DUMP="${1:?informe o arquivo .sql.gz}"
DB_URL="${2:?informe a DATABASE_URL de destino}"
COUNTS="${3:-}"

TRUNCATE_SQL="$(psql "$DB_URL" -At -v ON_ERROR_STOP=1 -c "
  SELECT 'TRUNCATE ' || string_agg(format('%I.%I', n.nspname, c.relname), ', ') || ' CASCADE;'
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND (n.nspname = 'public' OR (n.nspname = 'auth' AND c.relname IN ('users', 'identities')))")"

# session_replication_role = replica: a carga não dispara triggers (o hash da
# trilha, as travas de exclusão) nem checa chaves estrangeiras no meio — os
# dados entram exatamente como estavam. É o procedimento indicado pelo Supabase.
gunzip -c "$DUMP" | psql "$DB_URL" --single-transaction -v ON_ERROR_STOP=1 -q \
  -c "SET session_replication_role = replica;" \
  -c "$TRUNCATE_SQL" \
  -f - \
  -c "SET session_replication_role = origin;"

if [ -n "$COUNTS" ]; then
  FAIL=0
  while read -r TABLE EXPECTED; do
    GOT="$(psql "$DB_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM $TABLE")"
    if [ "$GOT" != "$EXPECTED" ]; then
      echo "DIVERGE: $TABLE esperado=$EXPECTED restaurado=$GOT"
      FAIL=1
    fi
  done < "$COUNTS"
  [ "$FAIL" = 0 ] && echo "Conferência: todas as $(wc -l < "$COUNTS") tabelas com a mesma contagem do backup."
fi

# Estatísticas do painel recalculadas depois da conferência (a atualização
# grava uma linha de controle, que não estava no backup).
psql "$DB_URL" -q -v ON_ERROR_STOP=1 -c "SELECT public.refresh_company_stats();" >/dev/null || true
[ "${FAIL:-0}" = 0 ] || exit 1
echo "Restauração concluída."
