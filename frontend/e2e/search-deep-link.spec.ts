import { test, expect } from "@playwright/test";
import { loginAsDemo } from "./helpers";

// Regressão de dois bugs reais que só apareciam juntos: (1) CommandPalette.select()
// ignorava qual resultado foi clicado (sempre navegava pra /documents sem
// folder_id/doc); (2) o efeito de deep-link em Documents.tsx só reagia no
// mount (dependia de current?.id, não de searchParams) — então abrir o
// Ctrl+K estando JÁ em /documents (o caso mais comum) não navegava pra
// lugar nenhum. Este teste reproduz exatamente esse cenário: já em
// /documents, abre a busca rápida e clica num resultado.
test("Ctrl+K a partir da própria tela de Documentos navega para o documento certo", async ({ page }) => {
  await loginAsDemo(page);

  await page.getByRole("link", { name: "Documentos" }).click();
  await expect(page).toHaveURL(/\/documents/);

  // Abre o Command Palette (botão "Buscar documentos..." no TopBar, não o
  // ícone de busca mobile-only escondido em telas largas).
  await page.getByRole("button", { name: /Buscar documentos/ }).click();

  const searchInput = page.getByPlaceholder("Buscar documentos, pastas ou ações…");
  await expect(searchInput).toBeVisible();
  await searchInput.fill("NF");

  const result = page.getByRole("button", { name: /\.xml Documento|\.pdf Documento/ }).first();
  await expect(result).toBeVisible({ timeout: 10_000 });
  const resultText = await result.textContent();
  await result.click();

  // Depois do clique: a paleta fecha, a URL ganha folder_id/doc, e a tabela
  // deixa de mostrar a listagem de pastas da raiz para mostrar só o
  // documento certo — com o Detail Drawer aberto.
  await expect(page.getByRole("heading", { name: "Detalhes" })).toBeVisible({ timeout: 10_000 });
  if (resultText) {
    const fileName = resultText.replace(/(Documento|Pasta)$/, "").trim();
    await expect(page.locator("aside", { hasText: "Detalhes" })).toContainText(fileName);
  }
});
