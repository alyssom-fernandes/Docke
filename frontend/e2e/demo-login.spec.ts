import { test, expect } from "@playwright/test";
import { loginAsDemo } from "./helpers";

test("modo demo abre o dashboard com dados reais da empresa", async ({ page }) => {
  await loginAsDemo(page);

  // StatCard renderiza <p>{value}</p><p>{label}</p> como irmãos (Dashboard.tsx).
  // Pega o número que precede o rótulo "Documentos" e confirma que é > 0 —
  // ou seja, a empresa carregada tem dados reais, não uma empresa vazia por engano.
  const label = page.locator("p", { hasText: "Documentos" }).first();
  const value = label.locator("xpath=preceding-sibling::p[1]");
  await expect(value).toBeVisible();
  const docCount = Number(await value.textContent());
  expect(docCount).toBeGreaterThan(0);
});
