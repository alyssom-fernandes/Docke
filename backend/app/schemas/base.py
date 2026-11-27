"""
Base dos modelos de resposta da API (X3-16).

Os modelos descrevem o contrato (vão para o OpenAPI e para os tipos do
frontend, em frontend/src/lib/api-types.ts) e conferem cada resposta, mas não
mexem nela: o JSON que sai é exatamente o que a rota devolveu, do mesmo jeito
que saía antes de a rota declarar response_model. Assim nenhum campo some da
tela por ter ficado de fora do modelo, e nenhuma data ou número muda de forma.

Conferência:
- com CONTRATO_ESTRITO (os testes ligam), campo a mais ou tipo errado é erro;
- em produção, a divergência vira um registro de erro (Sentry), uma vez por
  modelo, e a resposta segue como veio.
"""
import logging
from collections.abc import Mapping
from typing import Any

from pydantic import (
    BaseModel,
    ConfigDict,
    PrivateAttr,
    SerializationInfo,
    SerializerFunctionWrapHandler,
    TypeAdapter,
    ValidationError,
    ValidatorFunctionWrapHandler,
    model_serializer,
    model_validator,
)

from app.config import settings

logger = logging.getLogger("docke.contrato")

_COMO_VEIO = TypeAdapter(dict[str, Any])
_avisados: set[str] = set()


def _avisar(modelo: str, motivo: str) -> None:
    if modelo in _avisados:
        return
    _avisados.add(modelo)
    logger.error("Resposta fora do contrato em %s: %s", modelo, motivo)


class Resposta(BaseModel):
    """Modelo de resposta: confere o que a rota devolve e serializa como veio."""

    model_config = ConfigDict(extra="allow")

    _bruto: Any = PrivateAttr(default=None)

    @model_validator(mode="wrap")
    @classmethod
    def _conferir(cls, valor: Any, handler: ValidatorFunctionWrapHandler) -> Any:
        try:
            modelo = handler(valor)
        except ValidationError as erro:
            if settings.CONTRATO_ESTRITO or not isinstance(valor, Mapping):
                raise
            _avisar(cls.__name__, str(erro))
            modelo = cls.model_construct(**dict(valor))
        else:
            sobra = sorted(modelo.model_extra or {})
            if sobra:
                if settings.CONTRATO_ESTRITO:
                    raise ValueError(f"campos fora do contrato de {cls.__name__}: {', '.join(sobra)}")
                _avisar(cls.__name__, f"campos não declarados: {', '.join(sobra)}")
        if isinstance(valor, Mapping):
            modelo._bruto = valor
        return modelo

    @model_serializer(mode="wrap")
    # Sem anotação de retorno de propósito: com ela, o OpenAPI passaria a
    # descrever a resposta pelo tipo anotado em vez dos campos do modelo.
    def _serializar(self, handler: SerializerFunctionWrapHandler, info: SerializationInfo):
        if self._bruto is not None:
            return _COMO_VEIO.dump_python(dict(self._bruto), mode=info.mode)
        return handler(self)
