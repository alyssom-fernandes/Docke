INSERT INTO public.users (id, username, full_name, role)
SELECT 
  id,
  split_part(email, '@', 1),  -- usa parte antes do @ como username
  split_part(email, '@', 1),  -- mesmo valor para full_name por ora
  'usuario'
FROM auth.users
WHERE id NOT IN (SELECT id FROM public.users);