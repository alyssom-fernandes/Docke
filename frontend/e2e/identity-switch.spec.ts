import { test, expect } from "@playwright/test";
import { loginAsDemo, seedStaleLocalStorage } from "./helpers";

// Regressão do bug real: docke_company nunca era limpo/revalidado ao trocar
// de identidade (ex.: sair de uma conta real e entrar no modo demo). O
// sintoma era o seletor de empresa ficar preso numa empresa antiga enquanto
// o avatar já mostrava a identidade nova — e a tela de Documentos ficava
// "vazia" porque buscava dados de uma empresa à qual a conta atual não tem
// acesso. Corrigido em CompanyContext.tsx (revalidação) e useAuth.ts
// (limpar docke_company quando o id do usuário muda).
test("trocar para o modo demo com uma empresa antiga em cache não deixa a UI presa na empresa errada", async ({ page }) => {
  await seedStaleLocalStorage(page, "aaaaaaaa-0000-0000-0000-000000000000");

  await loginAsDemo(page);

  // O nome da empresa antiga jamais deveria aparecer.
  await expect(page.locator("header")).not.toContainText("Empresa obsoleta");

  // E a tela de Documentos precisa mostrar conteúdo real, não "Pasta vazia"
  // (o que aconteceria se a empresa errada continuasse selecionada).
  await page.getByRole("link", { name: "Documentos" }).click();
  await expect(page).toHaveURL(/\/documents/);
  await expect(page.getByText("Pasta vazia")).not.toBeVisible({ timeout: 5_000 });
});
