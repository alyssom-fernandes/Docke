import { test, expect } from "@playwright/test";
import { loginAsDemo } from "./helpers";

// Regressão: PreviewModal.tsx buscava a URL do PDF via /documents/:id/download-url
// (Content-Disposition: attachment), forçando o browser a baixar o arquivo em
// vez de abrir inline no modal. Corrigido para usar /documents/:id/preview-url
// (Content-Disposition: inline) para PDF/imagem.
//
// Não confiamos no evento "download" do Chromium aqui: o "headless shell" que
// o Playwright baixa por padrão não embute o visualizador de PDF do Chrome,
// então ele trata QUALQUER navegação de iframe para um PDF como download,
// mesmo com Content-Disposition: inline — isso foi confirmado rodando este
// teste manualmente contra o app real. O que realmente importa é o header
// HTTP em si, então checamos a resposta direto via page.request.
test("Visualizar um PDF usa preview-url com Content-Disposition: inline", async ({ page }) => {
  await loginAsDemo(page);
  await page.getByRole("link", { name: "Documentos" }).click();
  await expect(page).toHaveURL(/\/documents/);

  // O seed (backend/app/seed/demo_data.py) distribui pelo menos um PDF em
  // cada uma das 4 pastas raiz (Fiscal/RH/Bancário/Contratos, sempre criadas
  // com esses nomes fixos) — RH sempre tem Holerite_*.pdf/Admissão_*.pdf dentro.
  await page.getByRole("button", { name: "RH" }).click();

  const pdfRow = page.locator("table tbody tr", { hasText: ".pdf" }).first();
  await expect(pdfRow).toBeVisible({ timeout: 10_000 });
  await pdfRow.click();

  await expect(page.getByRole("heading", { name: "Detalhes" })).toBeVisible();
  await page.getByRole("button", { name: "Visualizar" }).click();

  const iframe = page.locator("iframe");
  await expect(iframe).toBeVisible({ timeout: 10_000 });
  const src = await iframe.getAttribute("src");
  expect(src).toBeTruthy();

  const response = await page.request.get(src!);
  expect(response.ok()).toBeTruthy();
  const disposition = response.headers()["content-disposition"] ?? "";
  expect(disposition).toContain("inline");
  expect(disposition).not.toContain("attachment");
});
