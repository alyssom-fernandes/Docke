# Docke — Protocolo de Execução
> **LEIA ESTE DOCUMENTO INTEIRO ANTES DE QUALQUER COISA, EM TODA SESSÃO.**
> Este é o "como trabalhar". As regras aqui valem para TODOS os milestones.
> Se em algum momento o que você for fazer contrariar este protocolo, o protocolo vence.

---

## O QUE É ESTE PROJETO

Você está construindo o **Docke**, uma ferramenta de Gestão Eletrônica de Documentos (GED) em nuvem para o Grupo Zen (postos de combustível, restaurantes, hotelaria). O Docke substitui um sistema legado chamado Arquivar. Stack: Python/FastAPI (backend) + Supabase PostgreSQL com RLS (banco) + Cloudflare R2 (storage) + React/TypeScript/Vite (frontend).

A fonte de verdade do produto é o arquivo `03-MANUAL-EXECUCAO.md` (arquitetura completa: schema, RLS, endpoints, OCR, storage, deploy). Os princípios visuais estão em `06-DESIGN-SYSTEM.md`. O tom de voz e microcopy estão em `07-VOICE-AND-MICROCOPY.md`. Decisões arquiteturais e seus motivos estão em `02-DECISOES-ARQUITETURA.md`. O que NUNCA pode ser violado está em `01-INVARIANTES.md`. Você deve ter todos esses arquivos disponíveis; se não os encontrar no projeto, peça ao desenvolvedor antes de continuar.

---

## REGRA ZERO — GIT É PROIBIDO

**Você NUNCA executa nenhum comando git.** Nada de `git add`, `git commit`, `git push`, `git checkout`, `git merge`, `git rebase`, ou qualquer outro. Você apenas cria e edita arquivos no sistema de arquivos local. Todos os commits são feitos manualmente pelo desenvolvedor através do GitHub Desktop. Se você sentir vontade de "salvar o progresso" com git, **não o faça**. Violar esta regra faz o nome errado aparecer como contribuidor no repositório.

---

## AS SETE LEIS DE EXECUÇÃO

### Lei 1 — Fatias verticais, nunca camadas horizontais
Implemente UMA funcionalidade completa de cada vez — da migration SQL à política RLS ao endpoint FastAPI ao componente React ao teste — antes de tocar na próxima. NUNCA faça "todo o backend, depois todo o frontend". Termine "CRUD de pastas com ltree" inteiro e funcionando antes de começar "upload de documentos". A qualquer momento, o que está marcado como feito deve estar 100% feito e funcionando.

### Lei 2 — Profundidade antes de largura
É proibido deixar uma tarefa "70% pronta para voltar depois". Ou a tarefa está completa e verificada, ou você ainda está nela. Não existe "depois eu termino". Um sistema com 5 funcionalidades sólidas vale infinitamente mais que um com 14 pela metade.

### Lei 3 — Código que não rodou não conta como feito
Toda funcionalidade deve ser executada de verdade no ambiente local (Supabase CLI + Uvicorn + Vite) antes de ser declarada pronta. Escrever o código não é terminar. Ver o código funcionar é terminar. Se você não rodou, não está pronto.

### Lei 4 — Toda tarefa tem Definição de Pronto e você verifica item por item
Cada tarefa no `05-PROGRESS.md` traz critérios de conclusão. Você só marca a tarefa como concluída depois de cumprir CADA critério e verificar de verdade. "Eu acho que está certo" não é verificação. "Eu rodei e vi funcionar com dados de teste" é verificação.

### Lei 5 — Atualize o PROGRESS.md depois de cada tarefa
Depois de concluir e verificar cada tarefa, atualize o `05-PROGRESS.md` imediatamente: marque com ✅, anote a data, e escreva uma linha sobre o que foi feito e testado. Este arquivo é a sua memória entre sessões. Trate-o como sagrado.

### Lei 6 — Nunca termine uma sessão com uma tarefa pela metade
Quando perceber que a conversa está ficando longa ou o contexto está enchendo, NÃO comece uma tarefa nova. Termine a atual, verifique-a, atualize o PROGRESS.md, e então faça um resumo do estado. É sempre melhor parar num ponto limpo do que no meio de algo.

### Lei 7 — Não invente, não derive, não "melhore" sozinho
Implemente exatamente o que os documentos de referência pedem — nada a mais, nada a menos. Não adicione funcionalidades não solicitadas. Não "melhore" partes que não foram pedidas. Se encontrar uma ambiguidade, consulte `03-MANUAL-EXECUCAO.md` e `02-DECISOES-ARQUITETURA.md`; se ainda assim estiver incerto, escolha a interpretação mais simples e coerente com o resto do sistema e anote sua decisão no PROGRESS.md. Funcionalidades extras não pedidas são a principal forma de um agente se perder e quebrar o que já funcionava.

---

## RITUAL DE INÍCIO DE SESSÃO (faça toda vez)

Sempre que começar a trabalhar — seja uma sessão nova ou a continuação — execute esta sequência antes de escrever qualquer código:

1. **Leia este protocolo** (`00-PROTOCOLO.md`) inteiro.
2. **Leia o `01-INVARIANTES.md`** para relembrar o que NUNCA pode ser violado.
3. **Leia o `05-PROGRESS.md`** para saber exatamente o que já foi feito e testado.
4. **Confirme que o ambiente está de pé**: Supabase CLI rodando? Uvicorn rodando? Vite rodando? Se não, suba-os (ver `04-AMBIENTE.md`).
5. **Identifique a próxima tarefa não concluída** no PROGRESS.md.
6. **Confirme que as dependências dela estão prontas** (ex: não implemente endpoints sem RLS estar testado).
7. Só então **comece a tarefa**.

Nunca pule o ritual. Ele garante que você nunca se perca, mesmo que o contexto tenha sido zerado entre sessões.

---

## RITUAL DE FIM DE TAREFA (a cada tarefa concluída)

1. Releia a Definição de Pronto da tarefa.
2. Execute a verificação — de verdade, no ambiente local.
3. Confirme item por item que tudo passou.
4. Atualize o `05-PROGRESS.md`: marque ✅, data, e uma linha do que foi feito.
5. **Sugira a mensagem de commit** no formato `tipo: descrição curta` (ex: `feat: adiciona CRUD de pastas com ltree`, `fix: corrige herança de permissão em subpastas`). O desenvolvedor fará o commit manualmente.
6. Passe para a próxima tarefa (ou encerre, se o contexto estiver enchendo — Lei 6).

---

## RITUAL DE FIM DE MILESTONE (quando todas as tarefas do milestone estiverem ✅)

1. Execute um **smoke test** completo: verifique que nada que funcionava antes quebrou.
2. Se algo falhar, conserte antes de prosseguir — regressão tem prioridade máxima.
3. Atualize o `05-PROGRESS.md` marcando o milestone inteiro como ✅.
4. Apresente ao desenvolvedor:
   - Resumo claro de tudo que foi feito no milestone.
   - **Os testes que SÓ ELE pode fazer** (upload real no R2, qualidade do OCR com scans reais, estética visual final no monitor, performance real), com passo a passo.
5. **Pare e aguarde.** Não invente o próximo milestone de memória. O desenvolvedor confirmará que pode prosseguir.

**PAUSA OBRIGATÓRIA APÓS MILESTONE 4:** Antes do M5 (Deploy), o desenvolvedor fará um teste de usabilidade com 1-2 funcionários reais do Grupo Zen usando o Docke com dados reais. Ajustes resultantes desse teste têm prioridade sobre o deploy.

---

## REGRAS DE CÓDIGO

### Estrutura e organização
- **Separação por tipo** no backend: `models/`, `routers/`, `services/`, `schemas/`. Nomenclatura explícita (ex: `documents.py`, não `models.py` genérico).
- **Separação por domínio** no frontend: `components/documents/`, `components/dashboard/`, etc.
- **Profundidade máxima de pastas**: 4 níveis úteis. Nunca `src/components/documents/table/rows/cells/icons/`.
- **Nomes proibidos de arquivos**: `utils.ts`, `helpers.ts`, `common.ts`, `misc.ts`. Use nomes explícitos: `permission_utils.ts`, `document_search.ts`.
- **Barrel exports** (`index.ts`) em cada pasta de componentes para imports limpos.
- **Testes colocalizados**: `test_documents.py` ao lado de `documents.py`, não em árvore separada.

### Quando dividir ou NÃO dividir um arquivo
- **Dividir** somente quando 2+ destas condições são verdadeiras: (a) ultrapassa ~300 linhas, (b) possui mais de uma responsabilidade claramente identificável, (c) metade das funções não usa a outra metade, (d) parte significativa poderia ser reutilizada independentemente em outro lugar.
- **Nunca dividir** apenas porque ultrapassou um número de linhas, se o arquivo representa uma única unidade conceitual coesa.
- **Nunca criar** um arquivo com menos de 20 linhas de lógica real (exceto ui/ primitives e types).
- **Nunca extrair** um subcomponente React para arquivo separado se ele for usado por um único componente-pai. Só divida se houver 2+ consumidores distintos.
- **Antes de criar novo arquivo**, escreva mentalmente: "Este arquivo existe porque [responsabilidade única que nenhum arquivo existente tem]". Se a justificativa for vaga, a extração é provavelmente desnecessária.
- Se um arquivo ultrapassar 300 linhas, **PARE e peça autorização ao desenvolvedor** em vez de decidir sozinho como dividir.

### Padrões técnicos obrigatórios
- **Config centralizada**: `app/config.py` com `pydantic.BaseSettings`. Nunca `os.getenv()` solto.
- **Nenhum router acessa banco diretamente**: toda query passa pelo service correspondente.
- **Services nunca retornam modelos ORM ao router**: sempre converter para schema Pydantic.
- **Exceções convertidas em HTTPException** apenas na camada de router, nunca dentro de services.
- **Migrations nunca são editadas depois de aplicadas**: correção é sempre via nova migration.
- **Zero emojis na interface**: apenas ícones SVG (Lucide Icons).
- **Todo texto de interface** segue as regras do `07-VOICE-AND-MICROCOPY.md`.
- **Toda escrita assíncrona** mostra loading state e é protegida contra duplo-clique.
- **Todo erro** é capturado com try/except e exibido com mensagem amigável em português (ver `07-VOICE-AND-MICROCOPY.md`). Nenhuma mensagem técnica crua chega ao usuário.

### Escala de duração de animações (3 valores, sem exceção)
- **120ms**: hover, focus, feedback de clique (micro-interações instantâneas)
- **180ms**: abertura de dropdown, transição de tema, crossfade de página
- **240ms**: modais abrindo/fechando, drawers, toast entrando/saindo

Easing padrão: `cubic-bezier(0.4, 0, 0.2, 1)` para tudo, exceto a animação de favoritar (Anchor Drop) que usa `cubic-bezier(0.34, 1.56, 0.64, 1)`.

---

## COMO LIDAR COM PROBLEMAS

- **Tarefa falhou na verificação:** conserte ali mesmo, não avance. Um bug local é fácil; não deixe virar sistêmico.
- **Bug em algo já marcado como ✅:** regressão. Pare a tarefa atual, conserte a regressão, confirme que o smoke test passa, só então retome.
- **Contradição entre documentos:** `01-INVARIANTES.md` > `03-MANUAL-EXECUCAO.md` > `06-DESIGN-SYSTEM.md` > este protocolo. Anote a contradição no PROGRESS.md.
- **Incerteza:** escolha o caminho mais simples, implemente, anote a decisão no PROGRESS.md.
- **Tentação de melhorar algo não pedido:** releia a Lei 7.

---

## RESUMO EM UMA FRASE

Trabalhe uma fatia vertical por vez, rode tudo no ambiente local, verifique com checklist, registre no PROGRESS.md, nunca pare no meio, nunca use git, nunca invente — e ao fim de cada milestone, ensine o desenvolvedor a testar o que só ele pode testar e aguarde aprovação para prosseguir.

---
*Fim do protocolo. Este documento é permanente e relido a cada sessão.*
