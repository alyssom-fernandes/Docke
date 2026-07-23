-- Fase 2.8: documenta a decisão de retenção como comentário no próprio
-- catálogo do banco — não é ausência de decisão, é decisão deliberada.
-- Nenhum job de purga deve ser criado pra esta tabela sem antes confirmar
-- a obrigação legal aplicável (fiscal: 5 anos do 1º dia do ano seguinte,
-- Art. 174 CTN; trabalhista: 5 anos, 2 após ação; ASO/PCMSO/PPRA/PPP: 20
-- anos). Concorrentes que purgam em 30-90 dias fazem isso por economia de
-- armazenamento, não porque é seguro — aqui é o oposto: reter mais é o
-- diferencial de produto (pesquisa "Auditoria e conformidade").
COMMENT ON TABLE public.activity_log IS
  'Event store append-only (I1). NUNCA criar job de purga automática sem confirmar a obrigação legal aplicável (fiscal 5a, trabalhista 5a/2a pós-desligamento, ASO/PCMSO/PPRA/PPP 20a) — reter além do mínimo de mercado é decisão deliberada de produto, não omissão.';
