-- Retenção do histórico de versões (benchmark B1.4.9): a empresa decide por
-- quanto tempo guarda uma versão depois que ela foi substituída. Nulo = para
-- sempre (o comportamento de hoje). Documento sob legal hold ou retenção
-- travada nunca perde versões (o gatilho do banco já recusa).
--
-- Aditivo: uma coluna nova, nula por padrão. Nenhum dado existente muda.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS versions_keep_days int
    CHECK (versions_keep_days IS NULL OR versions_keep_days BETWEEN 30 AND 3650);

COMMENT ON COLUMN public.companies.versions_keep_days IS
  'Dias que uma versão antiga é guardada depois de substituída (nulo = para sempre). O worker de manutenção apaga as vencidas.';
