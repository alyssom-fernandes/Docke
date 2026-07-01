# Docke — Tom de Voz e Microcopy
> Este documento define como o Docke "fala" com o usuário.
> Toda mensagem de interface (toast, empty state, erro, confirmação, label, tooltip)
> deve seguir estas diretrizes. O Claude Code consulta este documento sempre que
> precisar escrever texto visível ao usuário.

---

## TOM DE VOZ

O Docke fala com o tom de um **colega de trabalho competente e calmo**: direto, útil, sem alarde. Nunca frio/robótico (como um sistema legado). Nunca casual/brincalhão (como um app de consumidor). Profissional mas próximo.

### Regras

1. **Frases curtas.** Uma ideia por frase. Máximo 2 frases por mensagem.
2. **Voz ativa.** "Documento enviado" em vez de "O documento foi enviado com sucesso".
3. **Sem jargão técnico.** Nunca "Erro 500", "timeout", "OCR failed", "RLS violation". Traduzir para consequência + ação.
4. **Sem exclamações.** Nunca "Sucesso!" ou "Pronto!". O sistema é calmo.
5. **Sem "Ops", "Algo deu errado", "Oops".** Infantiliza o produto.
6. **Sem linguagem corporativa vazia.** Nunca "Operação concluída com êxito". Dizer o que foi feito, especificamente.
7. **Erros são pedidos de ajuda, não acusações.** "Não foi possível..." em vez de "Você não pode...". Sempre sugerir a próxima ação.
8. **Quantificar quando possível.** "4 arquivos movidos para Contratos" em vez de "Arquivos movidos com sucesso".
9. **Verbos de ação claros.** "Mover para lixeira", "Ancorar como favorito", "Subir documento".
10. **Sem redundância com a UI.** Se o botão diz "Upload", o toast não precisa dizer "Upload concluído com sucesso" — pode dizer apenas "NF-e Maio.pdf subida para Fiscal".

---

## EXEMPLOS CANÔNICOS POR CATEGORIA

Estas são as versões finais — usar como referência para todas as mensagens similares.

### Sucesso de ação
```
NF-e Maio 2026.pdf subida para Fiscal > 2026 > Maio.
```
```
4 arquivos movidos para Contratos.
```
```
Pasta "RH 2026" criada.
```

### Erro técnico (conexão/servidor)
```
Não foi possível carregar os documentos agora. Tente novamente em alguns segundos.
```
```
A conexão caiu durante o envio. Verifique sua internet e tente de novo.
```

### Erro de permissão
```
Você precisa de permissão do gestor para acessar esta pasta.
```
```
Solicite acesso ao administrador da empresa.
```

### OCR (falha e sucesso)
```
Não foi possível extrair o texto de Contrato Social.pdf. A busca por conteúdo não funcionará para este arquivo. Tentar de novo?
```
```
Texto extraído com sucesso. Este documento agora é encontrável pela busca.
```

### Empty states
```
Nenhum documento aqui ainda. Arraste arquivos para esta pasta ou use o botão Upload.
```
```
Nenhum documento encontrado com esses termos. Tente outra busca ou verifique os filtros.
```
```
Nada na lixeira. Itens excluídos aparecem aqui por 30 dias.
```
```
Você não tem acesso a esta pasta. Solicite acesso ao administrador.
```
```
Nada ancorado ainda. Clique no ícone de âncora em qualquer documento ou pasta para fixá-lo aqui.
```

### Confirmação destrutiva
```
Mover "NF-e Maio.pdf" para a lixeira?
(botão: Mover para lixeira)
```
```
Excluir permanentemente "Rascunho.pdf"? Esta ação não tem volta.
(botão: Excluir permanentemente)
```
```
Excluir permanentemente 12 itens? Esta ação não tem volta. Digite CONFIRMAR para continuar.
(input + botão: Excluir permanentemente)
```
```
Excluir a pasta "RH 2025"? Os 42 arquivos dentro dela serão enviados para a lixeira.
(botão: Mover para lixeira)
```

### Avisos não-críticos
```
Você está usando 82% do espaço disponível. Considere arquivar documentos antigos.
```
```
Este arquivo é grande demais para visualização rápida. Faça o download para abrir.
```
```
O OCR ainda está processando este documento. A busca pelo conteúdo ficará disponível quando terminar.
```

### Conflito de restauração
```
A pasta original foi removida. Escolha um novo destino para restaurar este documento.
(seletor de pasta + botão: Restaurar aqui)
```

### Conflito de nome no upload
```
Já existe um arquivo com o nome "NF-e Maio.pdf" nesta pasta. O que deseja fazer?
(opções: Substituir / Manter ambos / Cancelar)
```

### Sessão expirada
```
Sua sessão expirou. Digite sua senha para continuar.
(input de senha + botão: Continuar)
```

### Task Center
```
Subindo 3 arquivos...
```
```
Gerando arquivo ZIP...
```
```
Exportando atividade para CSV...
```
```
OCR processando Contrato.pdf...
```

---

## ANTI-PADRÕES (nunca usar)

| Proibido | Por que | Usar em vez disso |
|---|---|---|
| "Sucesso!" | Exclamação vazia | "Documento enviado." |
| "Erro inesperado" | Não informa nada | "Não foi possível [ação]. Tente novamente." |
| "Ops! Algo deu errado" | Infantil, vago | "Não foi possível [ação]. [próximo passo]." |
| "Operação concluída com êxito" | Corporativês | "[O que foi feito], especificamente." |
| "Erro 500: Internal Server Error" | Técnico, frio | "Não foi possível carregar agora. Tente de novo." |
| "Upload concluído com sucesso!" | Redundante com UI | "NF-e Maio.pdf subida para Fiscal." |
| "Você não pode fazer isso" | Acusatório | "Solicite acesso ao administrador." |
| "Tem certeza?" | Banaliza a gravidade | "Esta ação [consequência específica]." |

---
*Fim do tom de voz. Todo texto de interface segue este documento.*
