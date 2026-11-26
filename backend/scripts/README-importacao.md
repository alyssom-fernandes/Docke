# Migração do Arquivar para o Docke

O `importar_arquivar.py` leva uma pasta de arquivos (a exportação do Arquivar) para uma empresa do Docke, com a data original, os metadados e a conferência de cada arquivo pelo SHA-256.

## Antes de começar

1. Exporte do Arquivar os documentos de uma empresa para uma pasta do computador, mantendo as subpastas.
2. Se o Arquivar exportar uma planilha com datas e índices, salve como CSV com estas colunas (as demais são ignoradas):
   - `caminho`: caminho do arquivo a partir da pasta exportada, por exemplo `RH/2024/Holerite janeiro.pdf`;
   - `data_original`: `2024-01-31`, `31/01/2024` ou `31/01/2024 14:30`;
   - `campo:<Rótulo>`: um metadado por coluna, por exemplo `campo:Fornecedor` ou `campo:CNPJ`. O campo é criado como texto se ainda não existir.
   Sem planilha, a data original vem da data de modificação de cada arquivo.
3. Você precisa ser admin da empresa toda no Docke (a data original só é aceita de admin).
4. Instale o Python 3.10 ou mais novo (python.org). O script não precisa de nenhum pacote extra.

## Ensaio sem enviar nada

```powershell
python importar_arquivar.py --origem "D:\Exportacao Arquivar\Posto Centro" --empresa "Posto Centro Ltda" --simular
```

## Importação

```powershell
python importar_arquivar.py --origem "D:\Exportacao Arquivar\Posto Centro" --empresa "Posto Centro Ltda" --email voce@empresa.com.br --manifesto "D:\Exportacao Arquivar\manifesto.csv" --pasta-destino "Arquivar"
```

A senha é pedida no terminal. A árvore de pastas entra dentro de `Arquivar` (criada se faltar). Pode interromper com Ctrl+C e rodar o mesmo comando de novo: o que já entrou é pulado.

## Conferência

No fim, o script mostra a conta (arquivos na origem × importados e conferidos × já existiam × falhas) e grava:
- `relatorio-importacao.csv`: um arquivo por linha, com o SHA-256 calculado no seu computador e o calculado pelo Docke sobre o arquivo guardado. `situacao` = `importado` (os dois batem), `ja_existia` (o mesmo conteúdo já estava na empresa), `falha` (veja a observação) ou `fora_do_padrao` (extensão não aceita, vazio ou acima de 200 MB);
- `relatorio-importacao-resumo.csv`: a mesma conta por pasta de origem.

Sugestão: importe primeiro uma empresa piloto, confira no Docke por amostragem e mantenha o Arquivar só para leitura até o fim da transição.
