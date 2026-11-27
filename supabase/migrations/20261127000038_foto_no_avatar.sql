-- Foto no avatar e cota de armazenamento (achados A2-41 e B4.2.8 da avaliação de 25/11/2026): cada pessoa pode
-- pôr uma foto na própria conta. Guardamos só a chave do arquivo no
-- armazenamento; a URL de leitura é assinada pela API a cada pedido.
--
-- Aditivo: coluna nova e opcional; sem foto, o avatar continua o monograma.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_key text;

COMMENT ON COLUMN public.users.avatar_key IS
  'Chave da foto da pessoa no armazenamento (avatars/<id>-<aleatório>.<ext>); vazio = monograma.';

-- Cota de armazenamento por empresa (B4.2.8), definida pelo administrador
-- geral. Vazio = sem limite (o comportamento de hoje).
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS quota_bytes bigint CHECK (quota_bytes IS NULL OR quota_bytes > 0);

COMMENT ON COLUMN public.companies.quota_bytes IS
  'Limite de armazenamento da empresa em bytes (arquivos atuais e versões). Vazio = sem limite.';
