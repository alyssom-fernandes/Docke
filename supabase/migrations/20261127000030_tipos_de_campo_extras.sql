-- Mais tipos de campo de metadado (achado B1.3.2 da avaliação de 25/11/2026):
-- texto longo, data e hora, múltipla escolha e endereço (URL).
-- Só amplia a lista aceita; nenhum valor existente muda.

ALTER TABLE public.custom_field DROP CONSTRAINT IF EXISTS custom_field_type_check;
ALTER TABLE public.custom_field
  ADD CONSTRAINT custom_field_type_check
  CHECK (type IN ('texto', 'cpf', 'cnpj', 'data', 'competencia', 'numero', 'selecao',
                  'moeda', 'email', 'telefone', 'cep', 'booleano',
                  'texto_longo', 'data_hora', 'multipla', 'url'));
