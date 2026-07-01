# Docke — Princípios de Produto
> Quando surgir uma decisão que não está prevista nos outros documentos,
> estes princípios são a bússola. São poucos de propósito — princípios demais
> viram ruído. O Claude Code consulta este documento quando precisa escolher
> entre duas abordagens igualmente válidas.

---

1. **Busca antes de navegação.** O jeito mais rápido de encontrar um documento deve ser sempre buscar, não navegar pela árvore. A busca é o coração do Docke, não um recurso auxiliar.

2. **Mostrar informação antes de exigir clique.** Metadados visíveis na listagem (tipo, tamanho, data, empresa, competência) são melhores do que escondê-los atrás de um clique em "detalhes". O usuário deve poder decidir qual documento quer sem abrir nenhum.

3. **A ação mais comum exige no máximo 2 cliques.** Achar documento + baixar, subir documento, favoritar pasta — se qualquer ação cotidiana exigir 3+ cliques, o fluxo está errado.

4. **Toda tela responde em menos de 200ms quando os dados já estão carregados.** Latência percebida é inimiga da adoção. Se a tela demora, o sistema "parece" lento mesmo que funcione. Skeleton imediato + dados depois.

5. **Permissões devem ser previsíveis, nunca surpreendentes.** O usuário nunca deve se perguntar "por que eu consigo ver isso?" ou "por que não consigo?". Herança por especificidade (path mais profundo vence) é a regra — sem exceções.

6. **Um documento nunca deve exigir download para ser compreendido.** Preview inline (PDF, imagem) existe para que o usuário confirme que é o documento certo sem sair do sistema. Se o preview não funcionar para o tipo de arquivo, avisar claramente.

7. **Profundidade sutil, não enfeite.** A beleza do Docke vem de hierarquia tipográfica, espaçamento generoso, contraste bem calibrado e animações significativas — não de efeitos decorativos, gradientes extras, ou glassmorphism desnecessário. Se um efeito não comunica informação ou feedback, ele não deve existir.

8. **O Docke é um porto seguro, não um almoxarifado.** A metáfora da âncora (fixar, proteger, organizar) guia a linguagem visual e verbal. Documentos são "ancorados" (favoritados), não "marcados". A lixeira "retém por 30 dias", não "exclui". O tom é de proteção e confiança, não de burocracia.

---
*Fim dos princípios de produto.*
