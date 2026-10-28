import { test, expect } from "@playwright/test";
import { loginAsDemo } from "./helpers";

// O reset da demo roda em todo boot da API, quase sempre com um visitante já
// dentro (a Fly desliga a máquina ociosa e a visita seguinte a liga). Ele
// recria empresas, pastas e documentos; quando os IDs mudavam, a sessão aberta
// ficava apontando para empresas apagadas e via as pastas vazias até recarregar.
const API_URL = process.env.E2E_API_URL ?? "http://localhost:8000";

test("reset da demo com a sessão aberta não esvazia as pastas", async ({ page }) => {
  await loginAsDemo(page);

  // Dispara o reset pela API, como o boot faz, sem recarregar a página.
  const token = await page.evaluate(() => localStorage.getItem("docke_token"));
  const reset = await page.request.post(`${API_URL}/api/v1/admin/demo/reset`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(reset.status()).toBe(204);

  // Só navegação dentro do app: a empresa carregada antes do reset tem de
  // continuar valendo, e a pasta RH sempre tem um PDF (pick_template no seed).
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/documents/);
  await page.locator("aside", { hasText: "Pastas" }).getByRole("button", { name: "RH", exact: true }).click();
  await expect(page.locator("table tbody tr", { hasText: ".pdf" }).first()).toBeVisible({ timeout: 10_000 });
});
