"""B2.5.6: conferência da assinatura digital do XML da NF-e (sem banco)."""
import base64
import datetime
import hashlib
from xml.dom import minidom

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID

from app.services.nfe_signature import canonicalize, verify_nfe_signature

# Exemplo 3.3 da recomendação C14N 1.0 do W3C (etiquetas, atributos e namespaces).
_ENTRADA_33 = """<doc>
   <e1   />
   <e2   ></e2>
   <e3   name = "elem3"   id="elem3"   />
   <e4   name="elem4"   id="elem4"   ></e4>
   <e5 a:attr="out" b:attr="sorted" attr2="all" attr="I'm"
      xmlns:b="http://www.ietf.org"
      xmlns:a="http://www.w3.org"
      xmlns="http://example.org"/>
   <e6 xmlns="" xmlns:a="http://www.w3.org">
      <e7 xmlns="http://www.ietf.org">
         <e8 xmlns="" xmlns:a="http://www.w3.org">
            <e9 xmlns="" xmlns:a="http://www.ietf.org"/>
         </e8>
      </e7>
   </e6>
</doc>"""

_SAIDA_33 = """<doc>
   <e1></e1>
   <e2></e2>
   <e3 id="elem3" name="elem3"></e3>
   <e4 id="elem4" name="elem4"></e4>
   <e5 xmlns="http://example.org" xmlns:a="http://www.w3.org" xmlns:b="http://www.ietf.org" attr="I'm" attr2="all" b:attr="sorted" a:attr="out"></e5>
   <e6 xmlns:a="http://www.w3.org">
      <e7 xmlns="http://www.ietf.org">
         <e8 xmlns="">
            <e9 xmlns:a="http://www.ietf.org"></e9>
         </e8>
      </e7>
   </e6>
</doc>"""


def test_c14n_exemplo_oficial_do_w3c():
    doc = minidom.parseString(_ENTRADA_33)
    assert canonicalize(doc.documentElement).decode() == _SAIDA_33


def test_c14n_subarvore_herda_namespace_e_escapa():
    doc = minidom.parseString('<a xmlns="urn:x" xmlns:p="urn:p"><b  z="1" y="&quot;&lt;">x &amp; y &gt; z</b></a>')
    b = doc.documentElement.firstChild
    assert canonicalize(b).decode() == '<b xmlns="urn:x" xmlns:p="urn:p" y="&quot;&lt;" z="1">x &amp; y &gt; z</b>'


_NFE = "http://www.portalfiscal.inf.br/nfe"
_CHAVE = "35261112345678000199550010000001231000001234"


def _certificado():
    chave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nome = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "EMPRESA FICTICIA LTDA:12345678000199")])
    agora = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(nome).issuer_name(nome).public_key(chave.public_key())
            .serial_number(1).not_valid_before(agora).not_valid_after(agora + datetime.timedelta(days=365))
            .sign(chave, hashes.SHA256()))
    return chave, cert


def _nfe_assinada(valor="100.00"):
    chave, cert = _certificado()
    # Forma canônica escrita à mão (independente da função testada).
    inf_canon = (f'<infNFe xmlns="{_NFE}" Id="NFe{_CHAVE}" versao="4.00">'
                 f'<ide><cUF>35</cUF><nNF>123</nNF></ide><total><vNF>100.00</vNF></total></infNFe>')
    digest = base64.b64encode(hashlib.sha1(inf_canon.encode()).digest()).decode()
    si_canon = ('<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">'
                '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>'
                '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>'
                f'<Reference URI="#NFe{_CHAVE}"><Transforms>'
                '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>'
                '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform></Transforms>'
                '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>'
                f'<DigestValue>{digest}</DigestValue></Reference></SignedInfo>')
    assinatura = base64.b64encode(chave.sign(si_canon.encode(), padding.PKCS1v15(), hashes.SHA1())).decode()
    der = base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()
    # O XML como chega: declaração, atributos em outra ordem, etiquetas vazias abreviadas.
    xml = (f'<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="{_NFE}" versao="4.00"><NFe xmlns="{_NFE}">'
           f'<infNFe versao="4.00" Id="NFe{_CHAVE}"><ide><cUF>35</cUF><nNF>123</nNF></ide><total><vNF>{valor}</vNF></total></infNFe>'
           '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>'
           '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>'
           '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>'
           f'<Reference URI="#NFe{_CHAVE}"><Transforms>'
           '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>'
           '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms>'
           '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>'
           f'<DigestValue>{digest}</DigestValue></Reference></SignedInfo>'
           f'<SignatureValue>{assinatura}</SignatureValue>'
           f'<KeyInfo><X509Data><X509Certificate>{der}</X509Certificate></X509Data></KeyInfo></Signature>'
           '</NFe></nfeProc>')
    return xml.encode()


def test_assinatura_valida_e_conteudo_alterado():
    r = verify_nfe_signature(_nfe_assinada())
    assert r["status"] == "valida", r
    assert r["titular"].startswith("EMPRESA FICTICIA")
    alterada = verify_nfe_signature(_nfe_assinada(valor="999.00"))
    assert alterada["status"] == "invalida"
    assert "mudou" in alterada["motivo"]


def test_sem_assinatura_e_xml_que_nao_e_nfe():
    sem = f'<NFe xmlns="{_NFE}"><infNFe Id="NFe{_CHAVE}" versao="4.00"><ide/></infNFe></NFe>'.encode()
    assert verify_nfe_signature(sem)["status"] == "ausente"
    assert verify_nfe_signature(b"<a/>")["status"] == "nao_conferida"
