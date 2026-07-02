# Docke — Adendo 04: Especificação Funcional v2

> Formaliza as decisões de escopo do v2 já tomadas em conversa
> (compartilhamento externo, notificações, versionamento, retenção de
> lixeira, densidade de tabela). Complementa `02-DECISOES-ARQUITETURA.md`
> (que declarou esses itens fora de escopo na v1 por design — ADR-008).

---

## ADR-022 — Compartilhamento Externo

### Schema
```sql
CREATE TABLE shares (
  id UUID PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('document','folder')),
  resource_id UUID NOT NULL,
  token TEXT UNIQUE NOT NULL,        -- gerado com entropia alta, ver nota de segurança
  password_hash TEXT,                -- nullable, bcrypt/argon2
  expires_at TIMESTAMPTZ,            -- nullable = nunca expira
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  view_count INT NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ
);

CREATE TABLE share_accesses (
  id UUID PRIMARY KEY,
  share_id UUID NOT NULL REFERENCES shares(id),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash TEXT,          -- hash, não IP bruto (LGPD)
  user_agent TEXT
);
```

### Regras
- Qualquer usuário autenticado pode gerar link (documento OU pasta) —
  decisão já tomada: como todo acesso fica logado, abuso é rastreável
- Senha opcional (hash, nunca texto puro)
- Expiração opcional: nunca, 24h, 7 dias, 30 dias, ou data customizada
- Revogação manual a qualquer momento pelo criador ou por admin/supremo
- Pasta compartilhada: destinatário navega só dentro da árvore daquela
  pasta (read-only), não sobe para fora da raiz compartilhada

### UI
- Ação "Compartilhar" no menu de contexto de documento/pasta → modal com
  toggle de senha, dropdown de expiração, botão "Copiar link", lista de
  links ativos daquele recurso com opção de revogar
- Página pública (`/s/:token`, fora da autenticação): prompt de senha se
  protegido, preview + botão de download, navegação read-only se for pasta,
  rodapé com marca Docke discreta
- Se o recurso original for excluído/movido pra lixeira, o link mostra
  "Este documento não está mais disponível" em vez de erro técnico

---

## ADR-023 — Notificações (escopo corrigido)

**Correção importante em relação à conversa original:** ao detalhar por
escrito, percebi uma sobreposição com o Task Center que já existe na v1.
O Task Center já cobre "meus uploads/processamentos em andamento" — incluir
isso de novo em "Notificações" duplicaria a função. Reformulei o escopo
para cobrir só o que o Task Center não cobre: **coisas que outras pessoas
fizeram**, não o status das suas próprias operações.

### Schema
```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('folder_activity','share_accessed')),
  resource_type TEXT,
  resource_id UUID,
  actor_user_id UUID REFERENCES users(id),  -- nullable (share_accessed pode ser anônimo)
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Eventos cobertos
1. **Atividade em pasta favoritada:** outro usuário fez upload, moveu ou
   excluiu um documento numa pasta que você favoritou
2. **Link de compartilhamento acessado:** alguém abriu um link que você
   gerou (agregado — não uma notificação por acesso, para não gerar spam;
   ex: "Seu link de NF-e Maio foi acessado 3 vezes hoje")

### Pergunta em aberto para a validação cruzada
Task Center e Notificações deveriam ser **um único ícone com duas abas**
(Atividade / Tarefas) ou **dois ícones separados** na topbar? A proposta
atual do protótipo já tem um ícone de lista (Task Center) — adicionar um
segundo ícone de sino pode poluir a topbar. Pedir opinião das IAs sobre
isso explicitamente.

### Fora de escopo (confirmado)
- Notificação por e-mail — fica pra v3
- Comentários/menções — não existem no produto, não geram notificação

---

## ADR-024 — Versionamento de Documentos

### Schema
```sql
ALTER TABLE documents ADD COLUMN current_version_id UUID REFERENCES document_versions(id);

CREATE TABLE document_versions (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id),
  version_number INT NOT NULL,
  storage_key TEXT NOT NULL,
  size BIGINT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Regras
- Upload de nova versão cria nova linha em `document_versions`, atualiza
  `documents.current_version_id`, incrementa `version_number`
- **Limite: 20 versões por documento** (configurável por admin/supremo em
  Configurações → Retenção). Ao exceder, a versão mais antiga é
  **fisicamente excluída** do storage (não vai pra lixeira — lixeira é por
  documento, não por versão)
- **Restaurar versão antiga sempre cria uma NOVA entrada de versão**
  (clona o conteúdo da versão escolhida) — nunca reverte apagando
  histórico. Essa foi a decisão já confirmada por você.
- Sem diff de conteúdo — fora de escopo, feature própria futura

### UI
- Painel de detalhes do documento ganha aba/seção "Versões": lista com
  número, autor, data, tamanho, ações (baixar essa versão, restaurar)

---

## ADR-025 — Retenção de Lixeira (configurável)

### Regras
- **Padrão: 30 dias** na lixeira antes de exclusão permanente automática
- Configurável por admin/supremo em Configurações → Retenção
- Job diário (cron) varre itens na lixeira mais antigos que o limite
  configurado e exclui permanentemente (remove do storage + marca registro)

### Pergunta em aberto para a validação cruzada
Se o admin **muda** o valor de retenção depois que já existem itens na
lixeira, o novo valor deve se aplicar **retroativamente** (recalcula a
data de exclusão de tudo que já está lá) ou só afeta itens colocados na
lixeira **a partir de agora**? Minha proposta é retroativo, por
simplicidade de modelo mental — mas quero a opinião das IAs sobre riscos
dessa escolha (ex: alguém reduzir de 30 para 3 dias e itens sumirem antes
do esperado).

---

## ADR-026 — Densidade de Tabela

### Regras
- `user_preferences.table_density`: `'compact' | 'comfortable'`, padrão
  `'comfortable'`
- Toggle na barra de ferramentas da tabela (ícone), troca via classe CSS,
  sem re-render de dados
- Modo compacto: reduz padding vertical das linhas, esconde colunas
  secundárias (ex: "modificado por")
- Reaproveita os mesmos componentes com prop `density` — não duplica
  testes visuais, conforme decisão original

---

## PWA — confirmado como adiado

Sem escopo definido nesta rodada, condicional a pedido real de usuário.
Não entra no pacote atual para o Claude Code.

---

## Referência

Este documento, junto com `ADENDO-01`, `ADENDO-02` e `ADENDO-03`, forma o
pacote completo de planejamento pós-v1. PWA é o único item do roadmap
original de v2 que permanece deliberadamente sem especificação (por
decisão, não por lacuna — ver ADR-008 original).
