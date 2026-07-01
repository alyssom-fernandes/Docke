# Docke — Invariantes
> **Regras que NUNCA podem ser violadas, em nenhuma circunstância.**
> Se alguma implementação parecer exigir a violação de qualquer invariante,
> PARE e consulte o desenvolvedor. A implementação está errada, não a regra.

---

## DADOS E SEGURANÇA

**I1.** `activity_log` é append-only. Nenhuma linha é jamais editada ou deletada. "Undo" cria um evento novo (`restore`), nunca modifica o evento original.

**I2.** `documents.company_id` deve ser idêntico ao `folders.company_id` da pasta que o contém. Validar via constraint ou service layer em todo INSERT/UPDATE que altere `folder_id`.

**I3.** `ocr_jobs` é a única autoridade sobre o estado de processamento de OCR. `documents.ocr_status` é espelho de leitura, atualizado APENAS pela rotina de sincronização do worker, na mesma transação que `ocr_jobs`. Nenhum outro código escreve em `documents.ocr_status`.

**I4.** Service role key NUNCA atende requisições de usuário comum. Ela é exclusiva para: seed do modo demo, worker de OCR, e jobs administrativos internos. Toda requisição autenticada repassa o JWT do usuário via `set_config('request.jwt.claims', ..., true)`. O parâmetro `true` (is_local) é obrigatório.

**I5.** RLS NUNCA é bypassado para queries de usuário. Se o RLS não está filtrando, a conexão está errada (provavelmente usando service role). Testar com `SELECT auth.uid()` após set_config.

**I6.** Mover uma pasta é atômico. Atualizar o path da pasta + propagar para descendentes acontece em uma única transação. Falha = rollback completo. Validar que o destino não é descendente da pasta sendo movida (prevenir ciclos). Usar `SELECT ... FOR UPDATE` na pasta antes de iniciar.

**I7.** Permissão mais específica (path mais profundo) sempre prevalece, independente de ser mais ou menos permissiva que o ancestral.

## CÓDIGO E ARQUITETURA

**I8.** Nenhum router acessa o banco diretamente. Toda query passa pelo service correspondente.

**I9.** `permission_service.py` (Python) existe apenas para UX/validação prévia. A autorização real é feita pelo RLS no Postgres. São duas coisas diferentes e não substituíveis.

**I10.** Migrations aplicadas nunca são editadas. Correção é sempre via nova migration.

**I11.** Nenhuma rotina de limpeza remove arquivo físico do R2 cujo registro ainda exista no banco. Banco e storage são um conjunto consistente.

## INTERFACE

**I12.** Zero emojis na interface. Apenas ícones SVG (Lucide Icons).

**I13.** Nenhuma mensagem técnica crua chega ao usuário. Todo erro exibido segue o tom de `07-VOICE-AND-MICROCOPY.md`: objetivo, calmo, sem jargão, com ação sugerida.

**I14.** Respeitar `prefers-reduced-motion`. Quando ativa, todas as animações são reduzidas a transições de opacidade ≤50ms ou removidas completamente.

---
*Fim dos invariantes. Este documento é permanente e consultado a cada sessão.*
