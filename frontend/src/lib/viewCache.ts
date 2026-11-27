/**
 * Última resposta de cada tela, guardada na memória da aba (achados A9-04 e
 * A6-21 da avaliação de 25/11/2026). Ao voltar a uma tela, ela mostra na hora
 * o que tinha da visita anterior e atualiza por baixo, sem esqueleto. Some ao
 * recarregar a página ou trocar de conta (logout limpa tudo).
 */
const store = new Map<string, unknown>();

export function readView<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function writeView<T>(key: string, value: T): T {
  store.set(key, value);
  return value;
}

export function clearViews() {
  store.clear();
}
