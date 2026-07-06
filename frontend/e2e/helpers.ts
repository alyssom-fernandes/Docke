import { Page, expect } from "@playwright/test";

/**
 * Loga via "Acessar modo demo" e espera a Dashboard carregar de verdade
 * (não só a navegação — espera o nome da empresa aparecer no seletor,
 * que só acontece depois do CompanyContext resolver /companies).
 */
export async function loginAsDemo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Acessar modo demo" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  // Botão do seletor de empresa no TopBar — só aparece com nome quando
  // companies.length > 0 (ver TopBar.tsx). Confirma que a empresa não
  // ficou presa em "Selecionar empresa" / travada num id morto.
  await expect(page.locator("header button").first()).not.toHaveText("Selecionar empresa", { timeout: 15_000 });
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
