-- =============================================================================
-- Docke — Legal hold e retenção travada valem em TODA exclusão
-- (achados X3-07 e A5-65 da avaliação de 25/11/2026)
--
-- Antes, só a exclusão de um documento pela rota individual conferia o legal
-- hold. A exclusão em lote, a exclusão de pasta (que manda os documentos para
-- a lixeira), a exclusão de versão antiga e a purga automática da lixeira não
-- conferiam nada: um documento sob hold podia ir para a lixeira e ser apagado
-- em definitivo quando o prazo dela vencesse.
--
-- Agora a regra mora no banco, para nenhum caminho do código escapar dela:
--   - documento sob legal hold (direto ou numa pasta ancestral) não vai para
--     a lixeira nem é apagado;
--   - documento com política de retenção TRAVADA ainda vigente (ou de prazo
--     indeterminado) também não;
--   - versão de documento bloqueado também não é apagada.
-- O reset da demo, que apaga as empresas fictícias inteiras, liga o desvio
-- docke.bypass_retencao só dentro da própria transação.
--
-- O erro sai como RAISE EXCEPTION (SQLSTATE P0001) com a mensagem começando
-- por DOCKE_EXCLUSAO_BLOQUEADA; a API traduz para HTTP 423 com texto claro.
-- Esta migration não altera nem apaga dados.
-- =============================================================================

-- Motivo do bloqueio, ou NULL se o documento pode ser excluído.
CREATE OR REPLACE FUNCTION public.document_deletion_block_reason(p_document_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF public.document_is_under_hold(p_document_id) THEN
    RETURN 'legal_hold';
  END IF;
  SELECT * INTO r FROM public.document_retention_info(p_document_id);
  IF FOUND AND r.locked AND (r.is_indeterminate OR r.expires_at IS NULL OR r.expires_at > current_date) THEN
    RETURN 'retencao';
  END IF;
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.document_deletion_block_reason(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.documents_guard_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  motivo text;
BEGIN
  IF current_setting('docke.bypass_retencao', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- UPDATE só interessa quando o documento está indo para a lixeira.
  IF TG_OP = 'UPDATE' AND NOT (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  -- Envio que nunca se completou (sem hash do conteúdo): é só o registro
  -- provisório do upload, sem documento de verdade a proteger.
  IF OLD.content_hash IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  motivo := public.document_deletion_block_reason(OLD.id);
  IF motivo IS NOT NULL THEN
    RAISE EXCEPTION 'DOCKE_EXCLUSAO_BLOQUEADA:%:%', motivo, OLD.name
      USING DETAIL = OLD.id::text;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_guard_soft_delete ON public.documents;
CREATE TRIGGER trg_documents_guard_soft_delete
  BEFORE UPDATE OF deleted_at ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_guard_deletion();

DROP TRIGGER IF EXISTS trg_documents_guard_delete ON public.documents;
CREATE TRIGGER trg_documents_guard_delete
  BEFORE DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_guard_deletion();

-- Versões: apagar uma versão antiga de documento bloqueado também é recusado.
-- Quando a própria linha do documento já saiu (cascata de uma exclusão que o
-- trigger acima liberou), o documento não é encontrado e nada é bloqueado.
CREATE OR REPLACE FUNCTION public.document_versions_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  motivo text;
  nome text;
BEGIN
  IF current_setting('docke.bypass_retencao', true) = 'on' THEN
    RETURN OLD;
  END IF;
  SELECT d.name INTO nome FROM public.documents d WHERE d.id = OLD.document_id;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  motivo := public.document_deletion_block_reason(OLD.document_id);
  IF motivo IS NOT NULL THEN
    RAISE EXCEPTION 'DOCKE_EXCLUSAO_BLOQUEADA:%:%', motivo, nome
      USING DETAIL = OLD.document_id::text;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_versions_guard_delete ON public.document_versions;
CREATE TRIGGER trg_document_versions_guard_delete
  BEFORE DELETE ON public.document_versions
  FOR EACH ROW EXECUTE FUNCTION public.document_versions_guard_delete();
