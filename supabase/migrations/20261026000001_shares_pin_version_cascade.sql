-- Link fixado numa versão some junto com a versão.
--
-- shares.pin_to_version_id apontava para document_versions sem ON DELETE:
-- excluir definitivamente um documento (lixeira, purge automático, descarte
-- por retenção, reset da demo) ou uma versão antiga falhava com violação de
-- FK sempre que existisse um link fixado nela. Um link que prometia
-- exatamente aquela versão não tem mais o que entregar; removê-lo é melhor do
-- que passar a servir outro conteúdo (SET NULL faria o link mostrar a versão
-- atual sem aviso). share_accesses já cascateia de shares.
--
-- Só muda o comportamento de exclusões futuras; nenhuma linha é alterada aqui.

ALTER TABLE public.shares
  DROP CONSTRAINT IF EXISTS shares_pin_to_version_id_fkey,
  ADD CONSTRAINT shares_pin_to_version_id_fkey
    FOREIGN KEY (pin_to_version_id) REFERENCES public.document_versions(id) ON DELETE CASCADE;
