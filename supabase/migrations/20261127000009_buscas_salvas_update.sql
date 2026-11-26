-- Buscas salvas: salvar de novo com o mesmo nome atualiza a consulta
-- (INSERT ... ON CONFLICT DO UPDATE), o que exige UPDATE. Em produção o papel
-- authenticated não recebe permissões por padrão (no Supabase local recebe,
-- por isso o CI não pegou). A política saved_searches_own continua limitando
-- cada pessoa às próprias buscas.
GRANT UPDATE ON public.saved_searches TO authenticated;
