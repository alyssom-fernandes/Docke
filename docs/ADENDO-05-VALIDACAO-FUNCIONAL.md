# Docke — Adendo 05: Validação Funcional v2 (Decisões Finais)

> Resultado da rodada de validação cruzada (5 IAs) sobre
> `ADENDO-04-ESPECIFICACAO-V2-FUNCIONAL.md`. Este documento corrige e
> substitui os pontos abaixo do Adendo 04.

---

## ADR-027 — Segurança do Compartilhamento Externo (correção do ADR-022)

**Convergência:** UUID v4 tem entropia suficiente (122 bits) — não precisa
de token customizado. O problema real não é o token, é a ausência de
rate limiting.

**Decisões finais:**
- Token permanece UUID v4, mas armazenado como **hash SHA-256** no banco
  (não texto puro) — se a tabela `shares` vazar, os tokens não são
  diretamente utilizáveis
- Rate limit de **geração de link**: 30 por hora + 100 por dia, por usuário
- Rate limit de **tentativa de senha** no endpoint público (`/s/:token`):
  5 tentativas por minuto por token, bloqueio de 15 minutos após exceder
- Toda tentativa (sucesso ou falha) gera evento em `activity_log` com
  timestamp e IP (hash, não bruto — mesma regra de privacidade já definida)
- Infraestrutura: rate limit implementado em memória (dicionário com TTL)
  no próprio backend — o volume de uso do Docke não justifica Redis ou
  camada externa

---

## ADR-028 — Notificações: Design Final (substitui a proposta original do ADR-023)

**Decisão:** um único ícone de sino na topbar, badge numérico único
(soma de tarefas em andamento + notificações não lidas). Ao clicar, abre
um popover dividido em duas seções **visuais** (não abas clicáveis):

1. **"Em andamento"** (topo) — uploads, OCR, exclusões em lote — cada item
   com barra de progresso. Seção some inteira quando não há nada em
   andamento.
2. **"Notificações"** (embaixo) — atividade em pasta favoritada, link
   acessado, token bloqueado por tentativas de senha (novo evento, ver
   ADR-031) — cada item com timestamp relativo e indicador de não-lido.

"Marcar todas como lidas" no rodapé afeta só a seção de notificações
(tarefas somem quando concluídas, não quando "lidas"). Esse design escala
bem para novos tipos de evento em v3 sem precisar redesenhar a estrutura.

---

## ADR-029 — Limite de Versionamento: Revisão (substitui parte do ADR-024)

**Decisões finais:**
- Limite reduzido de 20 para **10 versões** por documento — motivo real
  não é custo de armazenamento (é irrisório no R2), é complexidade de UI
  e custo de reprocessamento
- **Ao atingir o limite, o sistema BLOQUEIA** novo upload de versão — não
  exclui a mais antiga automaticamente. Mensagem: "Este documento atingiu
  o limite de 10 versões. Exclua uma versão antiga manualmente ou crie um
  novo documento." (Correção crítica: a versão mais antiga pode ser o
  documento original com valor probatório fiscal — exclusão automática é
  arriscada em contexto de compliance.)
- Toda nova versão **dispara OCR novamente** automaticamente, já que o
  conteúdo pode ter mudado materialmente

---

## ADR-030 — Retenção de Lixeira com Carência (substitui a proposta retroativa pura do ADR-025)

**Decisão final:** fórmula de carência.

```
carência_dias = min(nova_retenção_configurada, 7)
```

Ao alterar a configuração de retenção:
- Itens na lixeira há **mais** tempo que `carência_dias` mantêm a regra
  **antiga** (a que valia quando foram excluídos)
- Itens na lixeira há **menos** tempo que `carência_dias` passam a valer
  a regra **nova** imediatamente

Isso dá efeito rápido para itens recém-excluídos (o cenário mais comum de
"admin quer liberar espaço agora") sem colocar em risco itens que já
estavam na lixeira há mais tempo, que mantêm a expectativa original.

**UI:** ao salvar uma mudança de retenção, exibir aviso explícito: "Itens
excluídos há mais de X dias manterão a retenção anterior. Itens mais
recentes seguirão a nova regra."

---

## ADR-031 — Interações Entre Features do v2 (lacunas identificadas na validação)

### Compartilhamento × Versionamento
Link público **fixa a versão no momento da criação** (não aponta sempre
para a mais recente) — evita que o destinatário veja um documento
diferente do que foi originalmente compartilhado, o que seria problema de
compliance. Opção "Vincular à versão mais recente" disponível no modal de
compartilhamento, **desmarcada por padrão**.

### Compartilhamento × Lixeira/Retenção
Ao excluir um documento permanentemente (seja por ação manual ou pela
retenção automática da lixeira), todos os `shares` associados são
marcados como `expired` e o objeto correspondente no storage é removido.

### Notificações × Versionamento
Quando um documento recebe nova versão, notificar: usuários que
favoritaram aquele documento/pasta, e usuários que o visualizaram
recentemente. **Não** notificar quem apenas criou o documento originalmente
(ele já sabe, foi ele quem fez o upload).

### Task Center × Versionamento
Upload de nova versão aparece no Task Center como tarefa normal, mas com
rótulo diferenciado: "Nova versão de [nome do documento]" em vez de
"[nome do documento] enviado" — evita confusão com upload de documento novo.

### Notificações × Segurança de Compartilhamento
Se um token de link é bloqueado por excesso de tentativas de senha (ver
ADR-027), o criador do link recebe notificação: "Seu link para [documento]
foi bloqueado por excesso de tentativas de senha. Gere um novo link se
necessário."

### Notificações × Retenção
Dois dias antes de um item ser removido permanentemente da lixeira, o
usuário que o excluiu recebe notificação: "[nome] será removido
permanentemente em 2 dias. Restaure-o se necessário." Evita perda
acidental — padrão comum em GEDs corporativos.

---

## Referência

Este documento fecha o pacote de planejamento pós-v1 junto com Adendos
01-04 e o protótipo visual. Próximo passo: atualizar o protótipo com as
correções técnicas do Adendo 03 e montar o prompt de handoff final.
