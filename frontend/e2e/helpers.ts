import { Page, expect } from "@playwright/test";

/**
 * Loga pelo bloco "Demonstração" da tela de bloqueio (nome acessível
 * "Explorar a demonstração") e espera o Início carregar de verdade (não só a
 * navegação — espera o nome da empresa aparecer no seletor, que só acontece
 * depois do CompanyContext resolver /companies).
 */
export async function loginAsDemo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explorar a demonstração" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  // Seletor de empresa (no topo da barra lateral) — só mostra o nome quando
  // companies.length > 0 (ver CompanySwitcher.tsx). Confirma que a empresa
  // não ficou presa em "Selecionar empresa" / travada num id morto.
  await expectCompanySelected(page);
}

/** O seletor de empresa mostra uma empresa de verdade, não "Selecionar empresa". */
export async function expectCompanySelected(page: Page) {
  const switcher = page.getByRole("button", { name: /Trocar de empresa$/ }).first();
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await expect(switcher).not.toHaveText("Selecionar empresa", { timeout: 15_000 });
}

/** Injeta uma sessão/empresa em cache ANTES de visitar /login, simulando o
 * cenário real de um usuário que já usou o app com outra conta/empresa. */
export async function seedStaleLocalStorage(page: Page, staleCompanyId: string) {
  await page.addInitScript((companyId) => {
    localStorage.setItem(
      "docke_company",
      JSON.stringify({ id: companyId, name: "Empresa obsoleta (pre-troca)", permission_level: "admin" })
    );
  }, staleCompanyId);
}
