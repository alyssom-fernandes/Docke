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

  await page.getByRole("link", { name: "Documentos", exact: true }).click();
  await expect(page).toHaveURL(/\/documents/);

  // Abre a busca rápida pelo atalho: em Documentos, o campo da barra de
  // ferramentas filtra a pasta, e a busca global fica no Ctrl+K.
  await page.keyboard.press("Control+K");

  const searchInput = page.getByRole("combobox", { name: /Digite um comando/ });
  await expect(searchInput).toBeVisible();
  await searchInput.fill("NF");

  const result = page.getByRole("option").filter({ hasText: /\.(xml|pdf)/ }).first();
  await expect(result).toBeVisible({ timeout: 10_000 });
  const resultText = await result.locator("span").first().textContent();
  await result.click();

  // Depois do clique: a paleta fecha, a URL ganha folder_id/doc, e a tabela
  // deixa de mostrar a listagem de pastas da raiz para mostrar só o
  // documento certo — com o Detail Drawer aberto.
  await expect(page.getByRole("complementary", { name: /^Detalhes de / })).toBeVisible({ timeout: 10_000 });
  if (resultText) {
    const fileName = resultText.trim();
    // Painel de detalhes = o bloco que contém o título "Detalhes" (cabeçalho + corpo).
    const details = page.getByRole("complementary", { name: /^Detalhes de / });
    await expect(details).toContainText(fileName);
  }
});
