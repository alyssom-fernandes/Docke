import { defineConfig, devices } from "@playwright/test";

// Contra o backend real (local ou já em execução) — os testes cobrem os
// fluxos que já quebraram de verdade em produção nesta base de código:
// login/modo demo trocando de identidade, deep-link de busca, preview inline.
// baseURL aponta pro `vite preview` (build de produção), levantado pelo
// próprio Playwright via webServer abaixo. O backend precisa estar de pé
// e com a base semeada (`python -m app.seed.demo_data`) ANTES de rodar isto —
// ver .github/workflows/e2e.yml para a orquestração completa em CI.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
        command: "npm run preview -- --port 4173",
        url: "http://localhost:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
