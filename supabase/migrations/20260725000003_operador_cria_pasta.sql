-- =============================================================================
-- Docke — Fase 9.5: corrige divergência conhecida "operador não pode criar
-- pasta" (registrada como pendente desde a revisão de código de 22/07/2026 e
-- confirmada no plano de fechamento das 11 rodadas — item 9.5).
--
-- Decisão: operador (equivalente a "editor" no resto do mercado GED — já tem
-- documents.write/versions.write/metadata.write) passa a poder criar
-- subpastas dentro do próprio escopo de acesso. Renomear/mover pasta
-- continuam exigindo 'admin', sem alteração — só a criação muda.
-- =============================================================================

DROP POLICY IF EXISTS "folders_insert" ON public.folders;
CREATE POLICY "folders_insert"
  ON public.folders FOR INSERT
  TO authenticated
  WITH CHECK (public.user_has_access(auth.uid(), path, company_id) IN ('admin', 'operador'));
