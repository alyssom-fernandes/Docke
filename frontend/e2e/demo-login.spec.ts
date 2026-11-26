import { test, expect } from "@playwright/test";
import { loginAsDemo } from "./helpers";

test("modo demo abre o dashboard com dados reais da empresa", async ({ page }) => {
  await loginAsDemo(page);

  // O contador de documentos do Início é um link cujo nome acessível começa
  // pelo total ("14 documentos, 1 enviados hoje. Abrir Documentos"). Confirma
  // que é > 0: a empresa carregada tem dados reais, não uma vazia por engano.
  const card = page.getByRole("link", { name: /^[\d.]+ documentos?,.*Abrir Documentos$/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const docCount = Number((await card.getAttribute("aria-label"))?.match(/^([\d.]+)/)?.[1].replace(/\./g, ""));
  expect(docCount).toBeGreaterThan(0);
});
