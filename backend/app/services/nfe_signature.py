"""
Conferência da assinatura digital do XML da NF-e (achado B2.5.6 da avaliação
de 25/11/2026), sem bibliotecas novas: canonicalização C14N 1.0 inclusiva
(http://www.w3.org/TR/2001/REC-xml-c14n-20010315, sem comentários) feita
sobre o minidom da biblioteca padrão e verificação RSA com `cryptography`.

O que é conferido: (1) o resumo (DigestValue) do elemento infNFe bate com o
conteúdo; (2) a assinatura (SignatureValue) do SignedInfo confere com a chave
pública do certificado que veio no próprio XML. Não é conferida a cadeia do
certificado até a ICP-Brasil nem a revogação: o resultado diz que o conteúdo
não mudou desde que o titular do certificado assinou.
"""
from __future__ import annotations

import base64
import hashlib
from typing import Any
from xml.dom import minidom

_DSIG = "http://www.w3.org/2000/09/xmldsig#"
_XMLNS = "http://www.w3.org/2000/xmlns/"
_DIGEST = {
    "http://www.w3.org/2000/09/xmldsig#sha1": hashlib.sha1,
    "http://www.w3.org/2001/04/xmlenc#sha256": hashlib.sha256,
}
_C14N = {"http://www.w3.org/TR/2001/REC-xml-c14n-20010315"}
_ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature"


def _esc_text(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\r", "&#xD;")


def _esc_attr(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
             .replace("\t", "&#x9;").replace("\n", "&#xA;").replace("\r", "&#xD;"))


def _ns_decls(el: minidom.Element) -> dict[str, str]:
    """Declarações de namespace feitas no próprio elemento: prefixo ("" = padrão) → URI."""
    out: dict[str, str] = {}
    for i in range(el.attributes.length):
        a = el.attributes.item(i)
        if a.name == "xmlns":
            out[""] = a.value or ""
        elif a.name.startswith("xmlns:"):
            out[a.name[6:]] = a.value or ""
    return out


def _in_scope(el: minidom.Element) -> dict[str, str]:
    """Namespaces em vigor no elemento (o mais próximo vale)."""
    chain = []
    node: Any = el
    while node is not None and node.nodeType == node.ELEMENT_NODE:
        chain.append(node)
        node = node.parentNode
    scope: dict[str, str] = {}
    for n in reversed(chain):
        scope.update(_ns_decls(n))
    return scope


def canonicalize(el: minidom.Element, skip: minidom.Element | None = None) -> bytes:
    """C14N 1.0 inclusiva, sem comentários, do elemento e descendentes. `skip`
    é tirado da saída (transformação enveloped-signature)."""
    out: list[str] = []

    def render(node: minidom.Element, rendered: dict[str, str], apex: bool) -> None:
        scope = _in_scope(node) if apex else {**rendered, **_ns_decls(node)}
        # Namespace a escrever: o que muda em relação ao que o pai de saída já escreveu.
        decls = []
        for prefix, uri in scope.items():
            if prefix == "xml":
                continue
            if prefix == "" and uri == "" and rendered.get("", "") == "":
                continue
            if rendered.get(prefix) != uri:
                decls.append((prefix, uri))
        decls.sort(key=lambda d: d[0])
        attrs = []
        for i in range(node.attributes.length):
            a = node.attributes.item(i)
            if a.name == "xmlns" or a.name.startswith("xmlns:"):
                continue
            attrs.append(((a.namespaceURI or ""), a.localName or a.name, a.name, a.value))
        attrs.sort(key=lambda t: (t[0], t[1]))
        out.append("<" + node.tagName)
        for prefix, uri in decls:
            out.append(f' xmlns="{_esc_attr(uri)}"' if prefix == "" else f' xmlns:{prefix}="{_esc_attr(uri)}"')
        for _, _, name, value in attrs:
            out.append(f' {name}="{_esc_attr(value)}"')
        out.append(">")
        now = {**rendered, **dict(decls)}
        for child in node.childNodes:
            if child is skip:
                continue
            if child.nodeType == child.ELEMENT_NODE:
                render(child, now, False)
            elif child.nodeType in (child.TEXT_NODE, child.CDATA_SECTION_NODE):
                out.append(_esc_text(child.data))
        out.append(f"</{node.tagName}>")

    render(el, {}, True)
    return "".join(out).encode("utf-8")


def _first(el: minidom.Element, local: str, ns: str = _DSIG) -> minidom.Element | None:
    found = el.getElementsByTagNameNS(ns, local)
    return found[0] if found.length else None


def _text(el: minidom.Element | None) -> str:
    return "".join(c.data for c in el.childNodes if c.nodeType == c.TEXT_NODE).strip() if el is not None else ""


def verify_nfe_signature(xml_bytes: bytes) -> dict[str, Any]:
    """{"status": "valida" | "invalida" | "ausente" | "nao_conferida", "motivo", "titular", "valido_ate"}."""
    from app.services.documents_service import safe_xml_fromstring  # recusa DOCTYPE/ENTITY

    try:
        safe_xml_fromstring(xml_bytes)
        doc = minidom.parseString(xml_bytes)
    except Exception:  # noqa: BLE001
        return {"status": "nao_conferida", "motivo": "O XML não pôde ser lido."}

    inf = None
    for el in doc.getElementsByTagName("*"):
        if el.localName == "infNFe":
            inf = el
            break
    if inf is None:
        return {"status": "nao_conferida", "motivo": "Não é um XML de NF-e."}
    ref_id = inf.getAttribute("Id")
    sig = None
    for s in doc.getElementsByTagNameNS(_DSIG, "Signature"):
        r = _first(s, "Reference")
        if r is not None and r.getAttribute("URI") == f"#{ref_id}":
            sig = s
            break
    if sig is None:
        return {"status": "ausente", "motivo": "O XML não tem assinatura digital do emitente."}

    try:
        from cryptography import x509
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        signed_info = _first(sig, "SignedInfo")
        ref = _first(signed_info, "Reference")
        c14n_alg = _first(signed_info, "CanonicalizationMethod").getAttribute("Algorithm")
        transforms = [t.getAttribute("Algorithm") for t in ref.getElementsByTagNameNS(_DSIG, "Transform")]
        if c14n_alg not in _C14N or any(t not in _C14N and t != _ENVELOPED for t in transforms):
            return {"status": "nao_conferida", "motivo": "A assinatura usa um formato que o Docke não confere."}
        digest_fn = _DIGEST.get(_first(ref, "DigestMethod").getAttribute("Algorithm"))
        sig_alg = _first(signed_info, "SignatureMethod").getAttribute("Algorithm")
        hash_alg = {"http://www.w3.org/2000/09/xmldsig#rsa-sha1": hashes.SHA1(),
                    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": hashes.SHA256()}.get(sig_alg)
        if digest_fn is None or hash_alg is None:
            return {"status": "nao_conferida", "motivo": "A assinatura usa um algoritmo que o Docke não confere."}

        cert = x509.load_der_x509_certificate(base64.b64decode(_text(_first(sig, "X509Certificate"))))
        cn = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
        titular = cn[0].value if cn else cert.subject.rfc4514_string()
        validade = cert.not_valid_after_utc.date().isoformat()
        base = {"titular": titular, "valido_ate": validade}

        digest = base64.b64encode(digest_fn(canonicalize(inf, skip=sig)).digest()).decode()
        if digest != _text(_first(ref, "DigestValue")).replace("\n", "").replace(" ", ""):
            return {"status": "invalida", "motivo": "O conteúdo da nota mudou depois de assinado.", **base}
        try:
            cert.public_key().verify(base64.b64decode(_text(_first(sig, "SignatureValue"))),
                                     canonicalize(signed_info), padding.PKCS1v15(), hash_alg)
        except InvalidSignature:
            return {"status": "invalida", "motivo": "A assinatura não confere com o certificado do XML.", **base}
        return {"status": "valida", "motivo": "O conteúdo é o mesmo que o titular do certificado assinou.", **base}
    except Exception:  # noqa: BLE001 — XML fora do padrão não derruba a tela
        return {"status": "nao_conferida", "motivo": "Não foi possível conferir a assinatura deste XML."}
