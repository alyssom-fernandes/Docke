"""
IDs da demo (app.seed.demo_data.demo_id): o reset roda em todo boot da API,
quase sempre com um visitante já dentro. Antes ele recriava empresas, pastas e
documentos com IDs novos, e a sessão aberta ficava com IDs apagados (pastas
vazias até recarregar). Aqui o núcleo do seed roda duas vezes contra uma
conexão falsa, sem banco e sem rede, e os IDs têm de sair iguais.
"""
from app.seed import demo_data

DEMO_USER_ID = "11111111-1111-1111-1111-111111111111"
EXTRA_USER_IDS = {
    email: f"22222222-2222-2222-2222-00000000000{n}" for n, (email, *_rest) in enumerate(demo_data.EXTRA_USERS)
}


class _FakeConn:
    """Guarda os comandos do seed; `fetch` devolve as empresas que já existiam."""

    def __init__(self, existing_company_ids):
        self.existing = existing_company_ids
        self.calls = []

    async def fetch(self, sql, *args):
        return [{"id": company_id} for company_id in self.existing]

    async def execute(self, sql, *args):
        self.calls.append((sql, args))

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return "33333333-3333-3333-3333-333333333333"

    def inserted_ids(self, table):
        return [args[0] for sql, args in self.calls if f"INSERT INTO public.{table}" in sql]


async def _seed(existing_company_ids):
    conn = _FakeConn(existing_company_ids)
    await demo_data._build_demo_data(conn, DEMO_USER_ID, EXTRA_USER_IDS)
    return conn


async def test_reset_recria_tudo_com_os_mesmos_ids(monkeypatch):
    keys = []
    monkeypatch.setattr(demo_data.storage_service, "put_object_bytes", lambda key, _data, _type: keys.append(key))

    primeiro = await _seed([])
    segundo = await _seed(primeiro.inserted_ids("companies"))

    for table, total in (("companies", 3), ("folders", 12), ("documents", 51)):
        ids = primeiro.inserted_ids(table)
        assert len(set(ids)) == total
        assert segundo.inserted_ids(table) == ids

    # O segundo reset apaga exatamente as empresas que o primeiro criou.
    apagadas = [args[0] for sql, args in segundo.calls if sql.startswith("DELETE FROM public.companies")]
    assert apagadas == [primeiro.inserted_ids("companies")]

    # As chaves no R2 repetem o caminho; só a extensão pode mudar com o sorteio do modelo.
    caminhos = [key.rsplit(".", 1)[0] for key in keys]
    assert len(caminhos) == 102
    assert caminhos[:51] == caminhos[51:]


def test_demo_id_e_estavel_e_distingue_os_caminhos():
    assert demo_data.demo_id("Empresa", "Fiscal") == demo_data.demo_id("Empresa", "Fiscal")
    assert demo_data.demo_id("Empresa", "Fiscal") != demo_data.demo_id("Empresa", "RH")
    assert demo_data.demo_id("Empresa", "documento", 1) != demo_data.demo_id("Empresa", "documento", 10)
