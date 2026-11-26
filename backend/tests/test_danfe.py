"""Campos do XML da NF-e para os quadros do DANFE (FA-A5-04)."""
from app.services.documents_service import DocumentsService

XML = """<?xml version="1.0"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe35260112345678000190550010000012341000012345">
<ide><nNF>1234</nNF><serie>1</serie><natOp>Venda</natOp><tpNF>1</tpNF><dhEmi>2026-01-02T09:00:00-03:00</dhEmi></ide>
<emit><CNPJ>12345678000190</CNPJ><xNome>Posto Alfa</xNome><IE>123456789</IE>
<enderEmit><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro><xMun>Campinas</xMun><UF>SP</UF><CEP>13000000</CEP></enderEmit></emit>
<dest><CPF>12345678909</CPF><xNome>Cliente</xNome></dest>
<det nItem="1"><prod><cProd>001</cProd><xProd>Gasolina comum</xProd><NCM>27101259</NCM><CFOP>5656</CFOP><uCom>L</uCom>
<qCom>10.0000</qCom><vUnCom>6.0000</vUnCom><vProd>60.00</vProd></prod>
<imposto><ICMS><ICMS00><CST>00</CST><vBC>60.00</vBC><pICMS>18.00</pICMS><vICMS>10.80</vICMS></ICMS00></ICMS></imposto></det>
<total><ICMSTot><vBC>60.00</vBC><vICMS>10.80</vICMS><vProd>60.00</vProd><vNF>60.00</vNF></ICMSTot></total>
<transp><modFrete>9</modFrete></transp><infAdic><infCpl>Obrigado pela preferência</infCpl></infAdic>
</infNFe></NFe><protNFe><infProt><nProt>135260000000001</nProt><dhRecbto>2026-01-02T10:00:00-03:00</dhRecbto></infProt></protNFe></nfeProc>""".encode()


def test_quadros_do_danfe():
    f = DocumentsService.extract_nfe_fields(XML)
    assert f["recognized"] and f["numero"] == "1234"
    assert f["emitente_endereco"] == "Rua A, 10, Centro, Campinas, SP, 13000000" and f["emitente_ie"] == "123456789"
    item = f["itens"][0]
    assert (item["descricao"], item["cst"], item["cfop"], item["valor_icms"], item["aliquota_icms"]) == ("Gasolina comum", "00", "5656", "10.80", "18.00")
    assert f["totais"]["vICMS"] == "10.80" and f["transporte"]["modalidade"] == "9"
    assert f["protocolo"] == "135260000000001" and f["informacoes_complementares"] == "Obrigado pela preferência"
