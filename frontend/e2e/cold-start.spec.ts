import { test, expect, Page } from "@playwright/test";
import { loginAsDemo } from "./helpers";

// A API na Fly desliga quando ociosa. Ao religar, a primeira chamada pode não
// chegar ao uvicorn, e o navegador a recebe sem resposta nenhuma. Aqui essa
// primeira chamada é recusada de propósito: o cliente (src/lib/api.ts) tem de
// tentar de novo sozinho, sem derrubar a sessão nem mostrar erro.

/** Recusa a primeira chamada ao caminho da API e deixa as seguintes passarem. */
async function refuseFirstCall(page: Page, path: string) {
  const calls = { count: 0 };
  await page.route(`**/api/v1${path}`, (route) => {
    // O preflight de CORS não conta: só a chamada de verdade.
    if (route.request().method() === "OPTIONS") return route.continue();
    calls.count += 1;
    return calls.count === 1 ? route.abort("connectionrefused") : route.continue();
  });
  return calls;
}

test("modo demo abre mesmo se a primeira chamada não chegar à API", async ({ page }) => {
  const calls = await refuseFirstCall(page, "/auth/demo-login");
  await loginAsDemo(page);
  expect(calls.count).toBe(2);
});

test("sessão salva continua se a primeira chamada não chegar à API", async ({ page }) => {
  await loginAsDemo(page);
  const calls = await refuseFirstCall(page, "/auth/me");
  await page.reload();
  // Sem a nova tentativa, o /auth/me que falhava apagava o token e mandava para o login.
  await expect.poll(() => calls.count, { timeout: 15_000 }).toBe(2);
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.locator("header button").first()).not.toHaveText("Selecionar empresa", { timeout: 15_000 });
  expect(await page.evaluate(() => localStorage.getItem("docke_token"))).not.toBeNull();
});
