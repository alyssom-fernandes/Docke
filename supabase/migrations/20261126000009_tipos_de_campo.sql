-- Tipos de campo de metadado (B1.3.2): moeda, e-mail, telefone, CEP e sim/não.
-- Só amplia a lista aceita; nenhum valor existente muda.

ALTER TABLE public.custom_field DROP CONSTRAINT IF EXISTS custom_field_type_check;
ALTER TABLE public.custom_field
  ADD CONSTRAINT custom_field_type_check
  CHECK (type IN ('texto', 'cpf', 'cnpj', 'data', 'competencia', 'numero', 'selecao',
                  'moeda', 'email', 'telefone', 'cep', 'booleano'));
