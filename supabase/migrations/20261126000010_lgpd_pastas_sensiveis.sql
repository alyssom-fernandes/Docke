-- LGPD: classificação de pastas com dado pessoal ou sensível (X2-17, B3.7.1).
--
-- RH, ASO e holerite têm dado pessoal e, no caso de saúde, dado sensível
-- (LGPD art. 5º, II). A classificação é da pasta e vale para as subpastas
-- (a mais restritiva do caminho prevalece). Efeito hoje: pasta com dado
-- sensível não pode ter link público. Aditiva: coluna nova com padrão
-- "normal", nenhum dado existente muda.

ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'normal'
    CHECK (sensitivity IN ('normal', 'pessoal', 'sensivel'));

COMMENT ON COLUMN public.folders.sensitivity IS
  'normal | pessoal (dado pessoal) | sensivel (saúde, biometria e afins, LGPD art. 5º II). Vale para as subpastas.';

-- Classificação efetiva: a mais restritiva entre a pasta e as acima dela.
-- SECURITY DEFINER porque quem só acessa uma subpasta não enxerga as pastas
-- de cima pela RLS, e a regra precisa valer mesmo assim. Devolve só o rótulo.
CREATE OR REPLACE FUNCTION public.folder_effective_sensitivity(p_folder_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN bool_or(a.sensitivity = 'sensivel') THEN 'sensivel'
           WHEN bool_or(a.sensitivity = 'pessoal') THEN 'pessoal'
           ELSE 'normal'
         END
  FROM public.folders f
  JOIN public.folders a ON a.company_id = f.company_id AND a.path @> f.path
  WHERE f.id = p_folder_id
$$;

REVOKE ALL ON FUNCTION public.folder_effective_sensitivity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.folder_effective_sensitivity(uuid) TO authenticated, service_role;
