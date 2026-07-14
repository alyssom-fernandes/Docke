# ADENDO-09 — Pesquisa competitiva (Arquivar + M-Files): o que vale trazer

> **Status: notas de pesquisa em consolidação.** Nada aqui autoriza código ainda.
> Alyssom está trazendo mais relatórios de deep research antes de fechar o
> escopo — este documento existe pra não perder o que já foi decidido/descartado
> entre uma rodada e outra. Itens marcados **PENDENTE** aguardam mais material
> ou uma decisão explícita antes de virar plano de execução.

---

## 1. Objetivo

Registrar, à medida que forem chegando relatórios de deep research sobre
sistemas de GED concorrentes (Arquivar, M-Files, e o que mais vier), o que:

- **já está coberto** pelo que o Docke tem ou pelo ADENDO-08 (Metadados
  Customizáveis) — não precisa de novo trabalho;
- é **genuinamente novo e vale considerar** — vira item de escopo futuro;
- foi **avaliado e conscientemente descartado** pro porte/objetivo do Docke —
  registrado pra não ser re-proposto do zero depois.

Fontes analisadas até agora: 2 relatórios sobre o Arquivar (GED brasileiro,
referência original do pedido de metadados customizáveis) e 2 relatórios sobre
o M-Files (Gemini + ChatGPT deep research).

---

## 2. Confirmação principal: modelo híbrido pasta + metadados está certo

Este é o achado mais importante das quatro leituras, porque é uma
**convergência independente** — duas ferramentas de pesquisa, analisando dois
produtos concorrentes diferentes, chegam à mesma recomendação pra quem constrói
um GED do zero: **não abandonar pastas**, usar pasta como eixo de acesso
grosso e camada de metadados como eixo de classificação fina.

- **Eixo organizacional (pasta):** define **onde** o documento mora e **quem**
  pode acessar — já resolvido pelo modelo de permissão do Docke
  (`user_company_access` + `user_has_access()` + `ltree`, sem mudança).
- **Eixo de classificação (metadados/Tipo Documental):** define **o que** o
  documento é e quais campos/regras de retenção se aplicam — é o que o
  ADENDO-08 começou a resolver com `custom_field`/`folder_field`.

Essas duas coisas são ortogonais, não concorrentes. O ADENDO-08 cobre o eixo
de classificação por pasta; um conceito de "Tipo Documental" (classificação
que atravessa pastas) seria uma camada **adicional opcional**, não substitui
nada — ver §5.

---

## 3. Já confirmado pelo schema atual (nenhuma mudança necessária)

- **Colunas tipadas em vez de EAV genérico**: `document_field_value` já usa
  `value_text`/`value_date`/`value_number` em vez de um blob JSON/EAV puro —
  exatamente o padrão que os relatórios do M-Files recomendam pra evitar
  conversão de tipo em runtime e manter índice de ordenação/filtro rápido.
- **Herança "mais específico vence" via `ltree`**: já é o mesmo padrão usado
  em `user_has_access()` e reaproveitado em `resolve_folder_fields()` —
  validado contra os dois relatórios do Arquivar, nenhuma mudança pedida.
- **Busca híbrida (estruturado + full-text)**: o Postgres com `tsvector`
  sobre `ocr_text` + filtros SQL sobre colunas tipadas já cobre o mesmo
  padrão que o M-Files resolve com um motor de busca externo (dtSearch/IDOL/
  Algolia). Não vale a complexidade de um Elasticsearch/Algolia pro porte do
  Docke agora.
- **Multi-tenancy via RLS num banco único** (em vez de banco físico separado
  por empresa/vault, como o M-Files faz): escolha melhor pro nosso caso —
  mesmo isolamento, muito menos operação. Não muda.

---

## 4. Confirmado, mas ainda sem escopo — Listas de Apoio

Os dois relatórios do Arquivar e os dois do M-Files descrevem essencialmente
a mesma ideia: uma lista de valores reutilizável entre vários campos de
seleção (em vez de cada campo `seleção` ter sua própria lista fixa em
`format_config.options`).

- **M-Files acrescenta**: listas podem ser **hierárquicas** (ex.: "Região"
  contendo sub-itens de estado) — refinamento opcional, não essencial pro
  MVP.
- **Ainda não tem tabela própria** — hoje `seleção` guarda as opções inline em
  `format_config.options` por campo. Migrar pra uma tabela `value_list` +
  `value_list_item` compartilhável entre campos/empresas é o próximo passo
  natural quando essa feature for priorizada.

**PENDENTE**: decidir se entra já no MVP de metadados ou fica pra uma
iteração depois de rodar em produção e ver se o padrão "options inline" gera
duplicação de fato.

---

## 5. Novo, mas fase avançada — metadado relacional/indireto

O M-Files permite um campo do tipo "lookup" apontar pra outro objeto (ex.: um
cadastro de "Fornecedor") e o documento **herdar/exibir automaticamente**
propriedades desse objeto (ex.: CNPJ, Razão Social) via uma notação tipo
`%Fornecedor.CNPJ%`.

Pro contexto do Docke (clientes de contabilidade), isso teria valor real:
cadastrar um fornecedor/cliente uma vez, e todo documento vinculado já vem
com CNPJ/Razão Social preenchidos sem digitar de novo.

**Por que não agora**: exige um conceito de "objeto" além de documento/pasta
— um cadastro de verdade (Fornecedor, Cliente) com sua própria tabela e tela,
não só um campo de texto. É uma estrutura nova e maior que tudo que está
planejado até aqui.

**PENDENTE**: anotado como ideia de fase bem futura (pós Fase 2 de
metadados), não entra no escopo atual.

---

## 6. Limitação real e consciente — campo de seleção é single-value

`document_field_value` tem `UNIQUE(document_id, custom_field_id)` — um campo
guarda **um valor só** por documento. Os relatórios do M-Files mostram
campos multi-seleção (ex.: "Departamentos relacionados: RH + Financeiro") como
caso de uso comum.

**Decisão**: não implementar agora. Registrado aqui como limitação conhecida
e consciente, não esquecimento — se um dia for pedido, exige relaxar o
`UNIQUE` ou criar tabela de junção, migration não-trivial mas isolada.

---

## 7. Avaliado e descartado — permissão automática por valor de metadado

No M-Files, definir um campo (ex.: "Confidencialidade = Alto") pode trocar
automaticamente a ACL do documento, combinada com outras fontes de permissão
por uma regra de "mais restritivo vence" (interseção/AND entre todas as
fontes simultâneas: pasta, classe, valor de metadado, estado de workflow).

**Por que não**: é caro até pra quem tem a infraestrutura deles — os próprios
relatórios mencionam que a busca do M-Files esconde de usuários comuns
qualquer objeto com mais de 4 fontes de ACL simultâneas, por causa do custo de
calcular a interseção toda consulta. Pro porte do Docke, o modelo atual
(papel por pasta, resolvido por especificidade de `ltree`, single-source)
é mais simples e mais barato de manter correto.

**Descartado conscientemente** — não re-propor sem uma razão de negócio muito
forte.

---

## 8. TTD / Retenção — arquitetura proposta (resolvida por pesquisa dedicada)

Dois relatórios de deep research sobre Microsoft Purview/SharePoint (Gemini +
ChatGPT) chegaram, focados especificamente em retenção documental. Combinados
com o que o M-Files já tinha sugerido (mesma máquina de estados controla
workflow e retenção), dá pra fechar a arquitetura. Um ponto de divergência
entre os dois relatórios importava resolver primeiro — ver §8.1.

### 8.1 Divergência entre os relatórios — qual versão adotar

- **Gemini** descreve um algoritmo de precedência elaborado com 4 princípios
  pra resolver **múltiplas políticas conflitantes** cobrindo o mesmo
  documento (retenção vence exclusão, maior prazo vence, explícito vence
  implícito, menor exclusão vence).
- **ChatGPT**, citando o comportamento real documentado da Microsoft, diz
  algo mais simples: **cada item só pode ter um rótulo de retenção por vez**;
  se duas políticas concorrem pelo mesmo item, vence a política **criada há
  mais tempo** — sem motor de interseção multi-fonte.

A versão do ChatGPT bate com o que o Docke já decidiu em outros lugares:
regra única resolvida por especificidade (`ltree`), sem múltiplas fontes
simultâneas — o mesmo raciocínio que já descartou o modelo de permissão
multi-fonte do M-Files (§7). **Adotado: modelo simples (um rótulo de
retenção por documento, resolvido por especificidade de pasta, sem
interseção).**

### 8.2 Modelo de dados (adaptado do Purview pro porte do Docke)

Mantém o padrão já usado em `custom_field`/`folder_field` — regra aplicada
por pasta com `ltree`, resolvida por "mais específico vence" via
`resolve_folder_fields()`-like function, reaproveitando a mesma abordagem.

- **`retention_label`** (catálogo por empresa): `id, company_id, name,
  trigger_type ('created_at'|'modified_at'|'event_based'), duration_days,
  action_type ('none'|'auto_delete'|'disposition_review'), relabel_target_id
  (nullable, pra encadeamento tipo "vira rótulo X depois de expirar")`.
  Os campos `is_record_lock`/`is_regulatory_lock` do relatório do Gemini
  (bloqueio de edição tipo WORM) ficam **fora do MVP** — não há pedido de
  negócio pra isso ainda; anotar como extensão futura se algum cliente
  contábil precisar de imutabilidade regulatória de verdade.
- **`folder_retention_rule`**: aplica um `retention_label` a um
  `folder_path` (ou raiz da empresa), mesmo padrão de `folder_field` —
  reaproveita a resolução por especificidade já existente, sem tabela nova
  de "múltiplas fontes".
- **`document_retention_state`**: `document_id, label_id, retention_start_date,
  retention_expiration_date, current_state
  ('ativo'|'pendente_revisao'|'pendente_purga'|'descartado')`. Calculado uma
  vez quando o documento entra na regra (ou quando o evento dispara, pra
  rótulos `event_based`).

### 8.3 Ciclo de vida (resolvido)

```
(sem retenção) → ativo → [expira]
                            ├─ action_type='auto_delete'   → pendente_purga (carência) → descartado
                            └─ action_type='disposition_review' → pendente_revisao → (aprovado) → pendente_purga (carência) → descartado
                                                                  → (revisor estende/reclassifica) → ativo (novo prazo)
```

- **Carência antes da purga física** (padrão do Purview: 15-93 dias conforme
  o relatório): reutilizamos a **mesma janela de carência que a Lixeira já
  usa** (ADR-025/030, já implementado) — não cria um segundo relógio de
  carência paralelo. Documento com retenção expirada e aprovada pra descarte
  cai na Lixeira normal, com um marcador (`origin='retention'` vs
  `origin='user_delete'`) só pra diferenciar na tela, mas passa pelo **mesmo
  worker de purga física** que já existe.
- **Coexistência com Lixeira (pergunta que estava aberta)**: resolvida — a
  retenção não cria um pipeline de exclusão paralelo. Ela só **bloqueia a
  exclusão manual/purga antecipada** enquanto `current_state='ativo'` ou
  `'pendente_revisao'`; uma vez liberado pra `pendente_purga`, o documento
  segue o fluxo de Lixeira já existente sem duplicar lógica.

### 8.4 Fluxo de aprovação (resolvido)

Só existe se `action_type='disposition_review'` no rótulo (a maioria dos
casos pode usar `auto_delete` ou `none` e nem precisa disso). Quando existe:

- Revisor = quem já tem papel `admin` na empresa/pasta (reaproveita o
  sistema de permissão existente — **não cria papel novo** de "revisor de
  disposição", ao contrário do Purview que tem grupo de segurança dedicado;
  overkill pro nosso porte).
- Ações do revisor: aprovar descarte (→ `pendente_purga`), estender prazo
  (recalcula `retention_expiration_date`, volta pra `ativo`), reclassificar
  (troca `label_id`, reinicia o cálculo). As três batem no `activity_log`
  já existente, sem tabela de auditoria nova.
- **Sem múltiplos estágios de revisão** (o Purview suporta N estágios em
  sequência) — um único nível de aprovação é suficiente pro porte do Docke;
  multi-estágio fica descartado por complexidade desnecessária.

### 8.5 Infraestrutura (resolvido — reaproveita o que já existe)

Os relatórios assumem Celery + Redis. **Não vamos adotar essa stack** — o
Docke já tem exatamente o padrão necessário: `maintenance_worker_loop`
(`backend/app/workers/maintenance_worker.py`, já rodando via
`asyncio.create_task` no lifespan do `main.py`). A extensão é:

- Adicionar ao mesmo worker periódico uma varredura de
  `document_retention_state WHERE current_state='ativo' AND
  retention_expiration_date <= now()`, paginada por cursor se o volume
  crescer, sem infraestrutura nova.
- Nada de tempo real: assim como o Purview mesmo (job semanal/diário), o
  processamento em lote é aceitável — não precisa reagir a evento síncrono
  na escrita.

### 8.6 O que fica de fora conscientemente (overkill pro porte do Docke)

- **Cópia-na-escrita / Preservation Hold Library oculta**: o Docke já tem
  versionamento de documento (`VersionsPanel.tsx`, ADR-024/029/034) e
  Lixeira com carência — isso já cobre a mesma necessidade (preservar a
  versão anterior antes de uma edição/exclusão) sem precisar de um bucket
  oculto paralelo. Retenção ativa só precisa **bloquear a purga física**
  enquanto vigente; edição normal já gera nova versão, que já fica
  preservada no histórico existente.
- **Log de auditoria encadeado por hash (SHA-256 chain)**: hardening de
  "eliminação defensável" pra cenários de auditoria jurídica pesada — não é
  um requisito de negócio atual dos clientes contábeis do Docke. Anotado
  como possível extensão futura se um cliente pedir conformidade mais
  rígida, não faz parte do MVP.
- **Deteção automática de conteúdo sensível pra auto-aplicar rótulo** (SIT,
  classificadores treináveis): fora de escopo — aplicação de rótulo de
  retenção fica manual/por pasta, igual à aplicação de metadados do
  ADENDO-08.
- **Integração com caixas de e-mail (Exchange MRM), Adaptive Scopes via AD,
  Simulation Mode**: específicos do ecossistema Microsoft 365, sem
  equivalente no Docke, descartados pelos próprios relatórios como overkill.

### 8.7 O que ainda falta decidir antes de virar milestone de execução

- Rótulos de retenção pré-definidos vs. cadastro livre por empresa (provável
  resposta: cadastro livre, mesmo padrão do `custom_field`).
  **PENDENTE — confirmar com Alyssom.**
- Duração da carência de purga: reaproveitar exatamente o valor já
  configurado em Retenção de Lixeira (`Settings/Retention.tsx`) ou permitir
  um valor específico por rótulo de retenção. **PENDENTE.**
- Se `disposition_review` deve gerar notificação (reaproveitando o sistema
  de notificações já existente, ADR-023/028/031) — resposta provável: sim,
  mesmo canal. **PENDENTE — confirmar.**

---

## 9. Pesquisa de retenção concluída (Purview/SharePoint)

Pesquisa dedicada já trazida e analisada (dois relatórios, Gemini + ChatGPT)
— ver §8 para a arquitetura resolvida. Não há mais pendência de pesquisa
pro tema de retenção; o que resta são as três perguntas de decisão de
negócio listadas em §8.7.

---

## 10. Sistemas contábeis brasileiros (Domínio, Alterdata, Questor) — 3 relatórios

### 10.0 Enquadramento — isso não é análise de concorrente

**Correção de escopo (Alyssom, 2026-07-13): o Docke não é um sistema
contábil, é uma plataforma de armazenamento em nuvem/GED.** Domínio,
Alterdata e Questor **não são concorrentes do Docke** — são ERPs contábeis
completos (folha, fiscal, contábil) que têm um módulo de documentos como
peça secundária dentro de um produto muito maior. A relação correta é: são
ferramentas que **os clientes do Docke (escritórios de contabilidade) já
usam para outra coisa**, e cujo módulo de documentos embutido molda a
expectativa desse público sobre como um GED deveria se comportar.

Os insights extraídos abaixo continuam válidos com essa correção — o
"buraco de mercado" da pendência de documentos e a ideia de auto-extração de
XML não dependem de Domínio/Alterdata/Questor serem concorrentes, só de
serem referência de expectativa do público-alvo. Mas nenhuma decisão de
posicionamento deve tratá-los como benchmark de paridade competitiva. Os
**concorrentes reais** do Docke, na categoria certa (armazenamento em nuvem
empresarial), são Box, Dropbox Business, Google Drive/Workspace e Egnyte —
analisados em §12. Arquivar e M-Files entram como referência de padrões de
GED corporativo, mas não competem diretamente pelo mesmo cliente do Docke.

Três relatórios (Gemini, ChatGPT, DeepSeek) sobre os módulos de documentos
desses ERPs. Esse é o único grupo de pesquisa com fonte tripla até agora, o
que ajuda a filtrar exagero — ver divergência em §10.1.

### 10.1 Divergência entre relatórios — qual versão adotar

Gemini descreve uma integração rica e automática entre documento e
calendário de obrigações fiscais (nomes de módulo, ícones, comportamento
detalhado). ChatGPT e DeepSeek — **dois relatórios independentes** — dizem
que essa vinculação direta **não existe nativamente**: o documento alimenta
o módulo fiscal/folha, que gera a guia/obrigação, mas o módulo de GED em si
não sabe que aquele XML específico gerou aquela obrigação específica. A
especificidade do relatório do Gemini (ícones exatos, nomes de robôs) tem
características de alucinação. **Adotado: a versão conservadora (ChatGPT +
DeepSeek) é mais confiável** — maioria (2 de 3) e menos detalhe suspeito.

Isso muda a leitura estratégica: a integração documento↔obrigação **não é
um recurso já resolvido pelo mercado** que precisaríamos alcançar — é um
espaço real de diferenciação ainda em aberto no setor.

### 10.2 Confirmado por consenso (3 relatórios concordam)

- **Importação/classificação automática de XML fiscal** (NF-e/NFS-e/CT-e)
  com extração de metadados (CNPJ, valor, data) é padrão consolidado em
  todos os players. Não vale competir nisso, mas vale **usar** o padrão:
  ver §11.3 (ideia nova).
- **Retenção documental é passiva/indefinida em todo o setor** — nenhum dos
  três sistemas analisados tem workflow de descarte, alerta de prazo de
  guarda ou revisão de disposição. Isso **confirma que o TTD do ADENDO-09
  §8 é um diferencial real**, não recurso de paridade — nenhuma das
  ferramentas que os clientes do Docke já usam no dia a dia oferece isso
  hoje (ver nota de enquadramento em §10.0).
- **Integração com governo é estreita**: os sistemas *transmitem* pro
  eSocial/SPED/DCTFWeb, mas **não baixam automaticamente** documentos do
  e-CAC pro acervo do cliente — a única automação de download real é XML de
  NF-e via SEFAZ. Bem mais restrito do que a descrição do Gemini sugeria —
  se algum dia isso entrar em escopo, o alvo certo é só "puxar XML de nota
  fiscal via SEFAZ", não um robô de portal genérico.
- **Motor de imposto/CFOP/regime tributário é fora de escopo** — os três
  relatórios concordam que isso é o núcleo caro e específico desses ERPs,
  não replicável nem desejável num GED genérico. Confirma decisão já óbvia
  do Docke de nunca entrar nesse território.

### 10.3 Novo e genuinamente valioso — dois achados

1. **"Pendências" de documentos do cliente é um buraco real do mercado**:
   ChatGPT e DeepSeek relatam, de forma independente, que **nenhum** dos
   três grandes sistemas (Domínio, Questor, Alterdata) tem um checklist
   nativo de "quais documentos o cliente ainda não enviou, com cobrança
   automática" — isso hoje só existe em players especializados menores
   (ex.: Nibo Docs, citado nos dois relatórios). Pro público-alvo do Docke
   (escritórios de contabilidade), isso é uma feature de alto valor
   percebido e baixo custo de construção: uma lista de "documentos
   esperados" por cliente/competência, com status pendente/recebido e
   lembrete automático — reaproveita o sistema de notificações já existente
   (ADR-023/028/031). **Candidato forte a entrar no backlog de execução.**
2. **Extração de metadados de XML fiscal pode alimentar o `custom_field`**:
   em vez de o contador digitar CNPJ/valor/data manualmente num campo
   customizado (ADENDO-08), o Docke poderia ler um XML de NF-e/NFS-e
   anexado e pré-preencher automaticamente campos correspondentes — é
   puramente extração de metadados de um arquivo estruturado (leitura de
   XML), não cálculo fiscal, então fica dentro do escopo de um GED sem virar
   ERP contábil. **Fase futura, mas tecnicamente simples** (parser de XML,
   sem lógica tributária) — anotar como possível M-I do ADENDO-08.

### 10.4 Descartado conscientemente

- Portais de folha de pagamento pro colaborador final (tipo Q-Colabore),
  chatbot de consulta fiscal, robôs de certidão negativa (CND) em milhares
  de prefeituras — tudo isso é núcleo do ERP contábil, não de um GED.
  Fora de escopo, sem ambiguidade.
- "Daisy-chaining" de etiqueta (rótulo muda sozinho conforme workflow, ex.:
  Rascunho→Ativo→Inativo por assinatura digital) — o próprio relatório do
  Gemini cita isso como inspirado no M-Files, que já discutimos e mantemos
  fora do MVP de retenção (`relabel_target_id` no ADENDO-09 §8.2 cobre o
  caso mais simples de encadeamento único; workflow de estados múltiplos
  fica fora por ora).

---

## 12. Concorrentes reais — Box, Dropbox, Google Drive, Egnyte (3 relatórios)

Três relatórios (Gemini, ChatGPT, DeepSeek) comparando os quatro players
que definem a categoria em que o Docke realmente compete: **armazenamento
e gestão de arquivos SaaS pra empresas**. Essa é a leitura mais importante
do ADENDO-09 pra posicionamento e roadmap — mais que Arquivar ou M-Files,
que são GED corporativo genérico, esses quatro moldam o que qualquer
usuário empresarial espera hoje ao abrir a plataforma pela primeira vez.

### 12.1 Divergência entre relatórios

- **Números específicos de limite** (Gemini): "Box aguenta 15.000 itens
  por pasta", "Dropbox 1.500 subpastas", "Drive 500.000 itens", "20 níveis
  em Shared Drives". ChatGPT/DeepSeek são propositalmente vagos nisso. Não
  dá pra confirmar sem checar a documentação oficial de cada um; tratado
  como **referência aproximada, não fato**. Pro Docke, o que importa é que
  os quatro aguentam facilmente ordens de grandeza acima do que qualquer
  cliente vai colocar — não é preciso replicar limites artificiais.
- **Senha em link público do Google Drive** (só DeepSeek): "Google Drive
  não permite senha em links — lacuna significativa". Gemini e ChatGPT não
  notaram. Se for verdade (confirmável em help.google.com), é um dado útil:
  **o gigante do mercado não faz uma coisa que o Docke já faz**. Anotado
  pra confirmar antes de virar argumento de posicionamento comercial.

### 12.2 Confirmado por consenso (3 relatórios concordam)

- **Todos os quatro usam pastas hierárquicas como estrutura primária**, com
  metadados customizados como camada secundária de enriquecimento — **é
  exatamente a arquitetura do Docke** (pasta + `custom_field`/ADENDO-08).
  Ninguém no topo do mercado adotou o modelo folderless-first do M-Files;
  isso valida a decisão de eixo duplo que já tomamos.
- **Criptografia AES-256 em repouso + TLS em trânsito** é table-stakes
  universal — Docke já entrega.
- **Google Drive é líder incontestável em edição colaborativa em tempo
  real** (Google Docs/Sheets nativos) — os outros três *integram* Office
  Online mas não competem nesse eixo. Pro Docke, replicar isso exigiria
  editor próprio, um projeto de anos; **não é campo a disputar**.
- **Egnyte é o único com armazenamento híbrido (cloud + on-premise)** —
  fora de escopo pro Docke por porte e complexidade operacional.
- **Dropbox Smart Sync é referência em sync desktop com placeholders** —
  também um projeto enorme; nenhum concorrente pequeno consegue replicar
  isso rapidamente.
- **BYOK/KMS (chave gerenciada pelo cliente)** existe nos quatro, sempre
  em tier Enterprise. Pro Docke, é feature de plano corporativo futuro,
  não MVP.
- **SSO/SAML é pay-wall universal** — presente em todos, sempre em plano
  superior. Confirma que dá pra deixar como feature de plano pago sem
  perder competitividade no free/entry.

### 12.3 Table-stakes que o Docke já tem (não é gap)

Pastas hierárquicas, permissões granulares por pasta, compartilhamento
externo com link público (senha + expiração), versionamento, busca
full-text + OCR, criptografia em repouso e trânsito, apps mobile web,
metadados customizados, retenção configurável de Lixeira, comentários
básicos (via ADR-023 notificações), **upload direto ao storage via
presigned URL** (verificado em 2026-07-13: `storage_service.py`
`generate_upload_url()` + `Documents.tsx`/`VersionsPanel.tsx` fazem PUT
direto no R2, o FastAPI nunca toca nos bytes — mesmo padrão que Box/
Dropbox/Drive/Egnyte usam. É PUT simples, não multipart chunked; migrar
pra multipart só faria sentido se o limite de 50MB for aumentado
significativamente no futuro). Nada aqui é novidade — mas os três
relatórios confirmam que essas são as feature-base sem as quais o produto
"perde relevância imediata".

### 12.4 Table-stakes que o Docke ainda NÃO tem — gaps reais

Priorizados pelo esforço de construir contra o valor percebido:

1. **SSO/SAML** — universal nos quatro, sempre em plano pago. Baixo esforço
   (Supabase Auth já suporta), alto valor pra vendas B2B. **Candidato de
   execução prioritário se o Docke for ter tier corporativo.**
2. **Marca d'água dinâmica em preview** (nome/e-mail do usuário sobre o
   documento visualizado) — Box, Dropbox, Egnyte oferecem. Deter conteúdo
   sensível de captura de tela sem bloquear leitura legítima. Esforço
   médio (overlay CSS no `PreviewModal.tsx`). **Bom candidato.**
3. **Comentários e @menções dentro do arquivo** — Google/Box têm sistemas
   maduros. O Docke tem sistema de notificação (ADR-023) mas não tem
   thread de comentário atrelada a documento. Esforço médio, valor
   moderado. Anotar como possível fase futura.
4. **File Locking** (trava manual pra editar sem conflito) — Egnyte
   automático, outros manual. Baixo esforço (flag + endpoint), baixo
   valor no fluxo atual do Docke onde edição raramente é feita in-app.
   Anotar como opcional.
5. **Sync desktop client** — Box Drive, Dropbox, Google Drive for Desktop
   têm. **Esforço enorme** (projeto de meses/anos com engine de watcher,
   conflict resolution, cache local). Descartado pro roadmap próximo.
6. **Edição em tempo real de Office/Google** — só via integração com Office
   Online / Google Docs (não editor próprio). Esforço médio de integração,
   valor moderado. Anotar como possibilidade futura via Office 365 embed.

### 12.5 Novo e valioso — um achado

1. **File Requests reforçados como padrão de mercado**: os três relatórios
   confirmam que Box, Dropbox e Egnyte oferecem "solicitação de arquivo"
   (link público que o terceiro usa pra **enviar** arquivos ao acervo, não
   pra baixar). Google **não tem nativo** — lacuna do gigante. Isso é o
   **mesmo pattern técnico do "pendências" identificado na §10.3.1** —
   agora com mais uma confirmação de que é um padrão consolidado no
   segmento certo do Docke, não só nicho contábil. Reforça o item #10 da
   tabela de pendências como candidato forte a execução.

**Verificado e já resolvido** (não é mais achado pendente): o upload
direto ao storage via presigned URL, que Box/Dropbox/Drive/Egnyte usam pra
evitar que o backend vire gargalo de banda, **o Docke já faz** — checado
em 2026-07-13 (`storage_service.py generate_upload_url()` + PUT direto ao
R2 no frontend). Ver nota em §12.3.

### 12.6 Descartado conscientemente

- **Sync desktop client tipo Dropbox Smart Sync**: projeto de escala
  desproporcional pro estágio do Docke — Dropbox construiu isso em uma
  década. Sem valor imediato; se um dia for pedido, considerar wrapper
  simples de WebDAV/rclone em vez de engine própria.
- **Editor colaborativo próprio tipo Google Docs**: mesmo caso.
- **Armazenamento híbrido (on-premise + cloud)**: Egnyte é o único que faz;
  vale só pra clientes com requisito regulatório específico de dado local.
  Fora do público-alvo do Docke.
- **File locking automático via watcher de sistema**: Egnyte-específico,
  não faz sentido sem sync desktop client.
- **BYOK/KMS**: pay-wall universal de Enterprise; sem cliente atual que
  pague por isso, adiado sem culpa. Volta quando fizer sentido comercial.

---

## 13. Padrões de interação (UX) — Finder/Explorer/Drive/Dropbox — 5 relatórios

Cinco relatórios (Perplexity, ChatGPT, DeepSeek, Grok, Gemini) sobre os
padrões de interação da tela principal de navegação de arquivos —
diferente dos §§1-12 que foram sobre arquitetura/features, este é
especificamente sobre **como a tela Docs deve se comportar** (seleção,
arraste, preview, atalhos, undo, mobile). Essa é a peça mais acionável
pro roadmap de UX porque conecta direto com o pedido de melhorar a aba
Docs e com a "casca Finder" já discutida e ainda pendente.

### 13.1 Divergências entre relatórios

1. **Semântica de drag & drop na web** (DeepSeek isolado): sugeriu
   aplicar a lógica desktop "mover no mesmo volume, copiar entre
   volumes" tratando pastas de clientes diferentes como "volumes"
   distintos. Os outros 4 relatórios seguem o modelo simples de Drive/
   Dropbox (sempre mover). **Adotado: sempre mover**, com Ctrl/⌥ como
   modificador opcional pra forçar cópia — expor essa nuance sem torná-la
   surpresa silenciosa.
2. **Persistência de preferência de visão** (lista/grade, colunas,
   ordenação): Finder/Explorer lembram por pasta; Drive/Dropbox são
   globais. 4 dos 5 relatórios recomendam **por pasta** pro Docke —
   escritórios contábeis têm pastas heterogêneas (contratos ≠ notas
   fiscais ≠ folha) que pedem colunas diferentes. Adotado por pasta,
   com fallback pra preferência global do usuário quando a pasta ainda
   não tem preferência salva.
3. **Arquitetura de preview** (2 níveis vs. 3 níveis): DeepSeek propôs
   3 (hover card + Space + painel lateral). Os outros defendem 2 (Space
   + painel lateral). Adotado 2 — hover card do Drive é elegante mas
   adiciona superfície de UI sem ganho claro no fluxo do contador.
4. **Detalhes datados específicos** (Gemini isolado): "F2 substituiu N
   no Drive em ago/2024", "Windows 11 24H2 restaurou labels textuais no
   menu de contexto", "Drive PDF viewer ganhou sumário em dez/2025".
   Tratado como plausível-mas-não-verificado (padrão de "IA inventa
   datas"); adoto a decisão de design (usar F2, usar labels textuais) mas
   sem citar as datas como fato.

### 13.2 Consenso forte (todos os 5 concordam)

- **Barra de Espaço = Quick Look** — atalho universal esperado por
  qualquer usuário de Mac. Ausência é sentida como "produto quebrado".
- **F2 = renomear inline** — Windows-origin, agora adotado por Drive/
  Dropbox. Universal.
- **Enter confirma, Esc cancela** em qualquer edição inline.
- **Extensão preservada automaticamente** ao renomear (nome fica
  editável, `.pdf` fica separado e imutável).
- **Shift/Ctrl/Cmd + clique** pra seleção múltipla — inviolável.
- **Ctrl/Cmd + A** seleciona tudo.
- **Rubber-band selection** (arrastar retângulo pra selecionar em área
  livre) é expectativa desktop; **Drive/Dropbox não implementam** e
  isso é considerado limitação legada, não impossibilidade técnica.
- **Clique no cabeçalho ordena, com seta indicando direção**.
- **Duplo-clique na borda da coluna = autofit** à maior célula.
- **Breadcrumb clicável com truncamento no meio** + dropdown pros
  níveis ocultos.
- **Ctrl+Z + toast "Desfazer"** pra ações reversíveis; web não sustenta
  histórico profundo, mas usuário espera pelo menos a última ação.
- **Ações destrutivas no final do menu de contexto, com separador e cor
  vermelha**.
- **Estado vazio com CTA claro** ("Fazer upload" / "Nova pasta"),
  nunca lista em branco.
- **Long-press = seleção múltipla no mobile**; checkbox sempre visível
  polui a interface e reduz densidade.
- **FAB (+) no canto inferior direito = criar/upload no mobile**.
- **Bottom sheet = menu de contexto no mobile**.
- **Barra de ações em lote**: topo no desktop, rodapé no mobile.

### 13.3 Novo e valioso pro Docke — backlog priorizado

Cada item mapeado com esforço estimado, com base no código atual que
conheço (`Documents.tsx`, `PreviewModal.tsx`, `FolderTree.tsx`,
`BottomTabBar.tsx`).

**Tier 1 — alto valor, baixo esforço (deve entrar no próximo ciclo):**

1. **Barra de Espaço abre preview** — hoje o Docke abre `PreviewModal`
   com clique. Adicionar handler global no `Documents.tsx` pra Space
   quando um único item está focado/selecionado. Ganho de percepção
   enorme com ~30 linhas.
2. **F2 renomeia inline** — hoje renomeação é via modal (assumo).
   Substituir por edição inline no `<td>` do nome, com Enter/Esc,
   validação em tempo real (duplicado + caracteres proibidos
   `\ / : * ? " < > |`), extensão fixa fora do input. Esforço médio.
3. **Rubber-band selection** — todos os 5 concordam que é lacuna real
   dos concorrentes web. Implementável em React com `mousedown/move/up`
   + `getBoundingClientRect()`. Diferenciador visível pra usuário
   desktop.
4. **Setas indicadoras nos cabeçalhos ordenáveis** — o Docke já tem
   ordenação (task #76 concluída); confirmar que a seta ▲▼ está visível
   e proeminente no cabeçalho ativo.
5. **Toast "Desfazer" pra mover/renomear/excluir** — mover pra Lixeira
   já usa esse padrão parcialmente (ADR-025). Estender pra mover entre
   pastas e renomear.
6. **Upload recursivo de pasta** via `webkitGetAsEntry` + `webkitRelativePath`
   — HTML5 padrão, todos os 4 concorrentes usam. Contador arrasta pasta
   anual de XMLs e o Docke reconstrói hierarquia. Esforço médio.

**Tier 2 — médio esforço, alto valor:**

7. **Preferência de visão/ordenação/colunas por pasta** — hoje é
   global (task #77, densidade). Persistir por `folder_id` num campo do
   `user_preferences` ou tabela nova pequena. Fallback pra preferência
   global quando ainda não há registro por pasta.
8. ~~Painel lateral de detalhes persistente~~ — **decidido: mantém modal
   centralizado** (task #75), por padronização entre mobile e desktop.
9. **Ghost image + highlight de pasta destino + spring-loaded** durante
   drag — hoje o Docke tem drag básico (task #62/mover). Refinar
   feedback visual: opacidade no item arrastado, borda azul na pasta
   destino, auto-expand após ~1.5s de hover.
10. **Session undo stack** (5-10 ações) em vez de só "última ação" —
    manter pilha em memória (Zustand/context) que Ctrl+Z consome. Mais
    profundo que Drive/Dropbox, mais raso que Finder — sweet spot pra
    contexto empresarial de arquivos.

**Tier 3 — nice-to-have:**

11. **Colunas Miller como modo alternativo** — só faz sentido se árvore
    profunda de clientes for uso comum. Complexo, valor incerto. Adiar.
12. **File System Access API** (`showOpenFilePicker`/`showDirectoryPicker`
    + IndexedDB pra persistir handles) — permitiria editar arquivo local
    e o Docke escrever de volta sem re-upload. Muito legal, mas escopo
    de projeto próprio; adiar até haver demanda concreta.
13. **Swipe actions no mobile** (esquerda = deletar, direita = favoritar)
    — o Docke não tem hoje; concorrentes têm em iOS. Esforço médio,
    valor moderado.

### 13.4 Descartado conscientemente

- **Sequestro do clique-direito** (padrão Dropbox web): Gemini alerta
  que Dropbox intercepta right-click e usuários reclamam de perder
  atalhos nativos do browser. Docke deve manter o menu customizado
  **mas** oferecer ícone de três pontos alternativo e permitir
  Ctrl/Cmd+clique abrir em nova aba.
- **Ícones monocromáticos por tipo de arquivo** (padrão Drive recente):
  Gemini nota que unificar ícones em cinza no Drive gerou reclamação
  forte. Manter cores distintas por extensão (PDF vermelho, XLSX
  verde, etc.) — o Docke já faz isso.
- **Permitir nomes duplicados na mesma pasta** (padrão Drive): pro
  contexto contábil é perigoso (auditoria confusa). Adotar padrão
  Dropbox: sufixo `(1)` automático em upload de duplicado, bloqueio
  imediato na renomeação inline com aviso visual.

---

## 11. Pendências consolidadas (aguardando mais material ou decisão)

| # | Item | Origem | Status |
|---|---|---|---|
| 1 | Listas de Apoio (tabela `value_list` compartilhável) | Arquivar + M-Files | Confirmado como valioso, sem data — §4 |
| 2 | Metadado relacional/indireto (lookup entre objetos) | M-Files | Fase bem futura, exige "objetos" tipo Fornecedor/Cliente — §5 |
| 3 | Campo de seleção multi-valor | M-Files | Limitação conhecida, não implementar sem pedido — §6 |
| 4 | TTD / retenção — arquitetura | Arquivar + M-Files + Purview (2x) | **Arquitetura resolvida** — §8; restam 3 decisões de negócio em §8.7 |
| 5 | Tipo Documental (classificação cross-pasta) | Arquivar | Camada opcional futura, não substitui pastas — §2 |
| 6 | Permissão automática por metadado | M-Files | **Descartado** — §7 |
| 7 | Rótulos de retenção: catálogo livre por empresa vs. pré-definido | Purview | Aberta — §8.7 |
| 8 | Carência de purga: reaproveitar config. de Lixeira ou valor próprio por rótulo | Purview | Aberta — §8.7 |
| 9 | Notificação de revisão de disposição via canal existente | Purview | Aberta — §8.7 |
| 10 | "Pendências" / File Requests (link pra receber arquivos + checklist) | Domínio/Alterdata/Questor + Box/Dropbox/Egnyte (6 relatórios) | **Candidato forte a execução** — §10.3.1 + §12.5.1 |
| 11 | Auto-preencher `custom_field` a partir de XML fiscal anexado | Domínio/Alterdata/Questor (3x) | Fase futura, tecnicamente simples — §10.3.2 |
| 12 | SSO/SAML corporativo | Box/Dropbox/Drive/Egnyte (3x) | Table-stakes de plano pago — candidato prioritário se houver tier corporativo — §12.4.1 |
| 13 | Marca d'água dinâmica em preview | Box/Dropbox/Egnyte (3x) | Esforço médio, valor real — §12.4.2 |
| 14 | Comentários/@menções dentro do arquivo | Google/Box (3x) | Esforço médio, valor moderado — §12.4.3 |
| 15 | ~~Upload direto ao S3 via presigned URL~~ | Box/Dropbox/Drive/Egnyte (3x) | **Verificado 2026-07-13 — Docke já faz isso** (PUT presigned simples, não multipart chunked; migrar só se limite de 50MB subir muito) — §12.3 |
| 16 | Confirmar se Google Drive realmente não suporta senha em link | DeepSeek (1x, não corroborado) | Fato a verificar antes de virar argumento comercial — §12.1 |
| 17 | Sync desktop client / editor colaborativo próprio / on-premise / BYOK | Box/Dropbox/Drive/Egnyte | **Descartados conscientemente** — §12.6 |
| 18 | UX Tier 1: Space=preview, F2=renomear inline, rubber-band, upload recursivo de pasta, toast desfazer estendido | Finder/Explorer/Drive/Dropbox (5x) | **Alto valor, baixo esforço — próximo ciclo** — §13.3 Tier 1 |
| 19 | UX Tier 2: preferência de visão por pasta, painel lateral persistente, drag refinado, session undo stack | Finder/Explorer/Drive/Dropbox (5x) | **Médio esforço, alto valor** — §13.3 Tier 2 |
| 20 | UX Tier 3: colunas Miller, File System Access API, swipe actions mobile | Finder/Explorer/Drive/Dropbox (5x) | Nice-to-have, adiado — §13.3 Tier 3 |
| 21 | ~~Painel de detalhes: modal centralizado vs lateral persistente~~ | Finder/Explorer (2x) | **Decidido 2026-07-13 por Alyssom: manter modal centralizado** — mesma experiência em mobile e desktop, sem duplicar padrão de interação — §13.3 item 8 |

Este documento será atualizado conforme mais relatórios chegarem. Quando
Alyssom confirmar que terminou de trazer material, os itens da tabela acima
que tiverem virado decisão fechada migram pra um adendo de execução (nos
moldes do ADENDO-08), e o restante continua registrado aqui como "avaliado e
adiado" ou "descartado".
