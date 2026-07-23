-- Fase 5.4-5.6: execução real do descarte + certificado de destruição.
--
-- Decisão de escopo confirmada explicitamente com o usuário (Lei 7): esta
-- migration só entra depois de 5.1-5.3 estarem testadas e da autorização
-- separada exigida pra qualquer coisa que apague documento de verdade.
--
-- "Aprovar" na fila (5.1-5.3) NUNCA executa nada — só marca a decisão.
-- Esta migration adiciona o passo seguinte, deliberadamente separado:
-- POST /retention/queue/{id}/execute, que só aceita item já 'approved',
-- reverifica hold, e só então apaga de verdade (banco + R2).
--
-- destruction_certificates é a evidência que PRECISA sobreviver ao
-- documento — por isso document_id aqui é uuid solto, SEM FK. A tabela
-- retention_review_queue tem document_id com ON DELETE CASCADE (correto
-- pra ela, é só a fila de trabalho); quando o documento é apagado, a linha
-- da fila desaparece junto — e é exatamente por isso que o certificado
-- precisa ser uma tabela separada e desacoplada, não uma coluna a mais na
-- fila.

CREATE TABLE IF NOT EXISTS public.destruction_certificates (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Sem FK de propósito — o certificado tem que continuar legível depois
  -- que o documento (e a linha da fila que o originou) já sumiram.
  document_id             uuid        NOT NULL,
  document_name_snapshot  text        NOT NULL,
  document_sha256         text,
  folder_path_snapshot    text,

  queue_item_id           uuid,
  policy_name_snapshot    text        NOT NULL,
  legal_basis_snapshot    text,

  reviewed_by             uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_by_name_snapshot text,
  reviewed_at             timestamptz,
  review_notes            text,

  executed_by             uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  executed_by_name_snapshot text      NOT NULL,
  executed_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_destruction_certificates_company ON public.destruction_certificates (company_id, executed_at DESC);

ALTER TABLE public.destruction_certificates ENABLE ROW LEVEL SECURITY;

-- Append-only, igual ao activity_log (I1): nenhuma policy de UPDATE/DELETE
-- é criada — uma vez emitido, o certificado nunca é alterado nem apagado.
DROP POLICY IF EXISTS "destruction_certificates_select" ON public.destruction_certificates;
CREATE POLICY "destruction_certificates_select" ON public.destruction_certificates FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_company_access uca WHERE uca.user_id = auth.uid() AND uca.company_id = destruction_certificates.company_id));
DROP POLICY IF EXISTS "destruction_certificates_insert" ON public.destruction_certificates;
CREATE POLICY "destruction_certificates_insert" ON public.destruction_certificates FOR INSERT TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

GRANT SELECT, INSERT ON public.destruction_certificates TO authenticated, service_role;
