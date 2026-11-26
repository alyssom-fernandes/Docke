"""
Confere se o conteúdo do arquivo bate com a extensão (X3-18).

Antes o tipo era aceito só pela extensão: um executável ou uma página HTML
com nome .pdf entrava e era servido como PDF. Aqui se olham os primeiros
bytes (assinatura do formato). Para formatos de texto (TXT, CSV, XML) basta
não ser binário. Os formatos antigos do Office (.doc/.xls) aceitam também
HTML/CSV/RTF, porque bancos e sistemas fiscais exportam "xls" que na verdade
são tabelas HTML ou CSV.
"""

_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ZIP = b"PK\x03\x04"
_BOMS = (b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff")


def _is_text(head: bytes) -> bool:
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):  # UTF-16 tem NUL entre os caracteres
        return True
    return b"\x00" not in head


def content_matches_extension(name: str, head: bytes) -> bool:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if not head:
        return ext in ("txt", "csv")  # arquivo vazio só faz sentido como texto
    if ext == "pdf":
        return b"%PDF-" in head[:1024]
    if ext == "png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in ("jpg", "jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == "gif":
        return head.startswith((b"GIF87a", b"GIF89a"))
    if ext in ("docx", "xlsx"):
        return head.startswith(_ZIP)
    if ext in ("doc", "xls"):
        return head.startswith((_OLE, _ZIP, b"{\\rtf")) or _is_text(head)
    if ext == "xml":
        body = head
        for bom in _BOMS:
            if body.startswith(bom):
                body = body[len(bom):]
                break
        return _is_text(head) and body.lstrip().startswith(b"<")
    if ext in ("txt", "csv"):
        return _is_text(head)
    return False


def describe(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].upper() if "." in name else "arquivo"
    return ext


def safe_xml_fromstring(data: bytes):
    """
    Lê XML recusando DOCTYPE e ENTITY (X3-18). A NF-e e o DOCX nunca os usam;
    com isso não há expansão de entidades (billion laughs) nem entidade
    externa, mesmo sem depender da versão do expat.
    """
    from xml.etree import ElementTree

    raw = bytes(data) if isinstance(data, (bytes, bytearray)) else str(data).encode("utf-8", "replace")
    low = raw.lower()
    if b"<!doctype" in low or b"<!entity" in low:
        raise ElementTree.ParseError("XML com DOCTYPE/ENTITY não é aceito.")
    return ElementTree.fromstring(data)
