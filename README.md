<p align="center">
  <img src="frontend/public/brand/docke-wordmark.png" alt="Docke" width="180" />
</p>

<p align="center">
  Multi-company document management: OCR search, tax-deadline tracking, legal retention and a hash-chained audit trail.
</p>

<p align="center">
  <a href="https://github.com/alyssom-fernandes/Docke/actions/workflows/ci.yml"><img src="https://github.com/alyssom-fernandes/Docke/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/alyssom-fernandes/Docke" alt="License: MIT" /></a>
</p>

<p align="center"><a href="README.pt-BR.md">Leia em português</a></p>

![Docke sign-in page](.github/readme/login.png)

## In 30 seconds

- **Several companies, one place.** Each company has its own folder tree; access is granted per company or per folder and enforced by Postgres Row Level Security, not only by the API.
- **Find what is inside the files.** Scanned PDFs and images go through Tesseract OCR (Portuguese) in a background worker, and full-text search highlights the matching passage.
- **Deadlines and retention.** Tax obligations with alerts, retention policies that explain *why* a policy applies to a document, and an impact preview before assigning one.
- **Every action is recorded.** The activity log is chained per company with an HMAC over the previous hash, so an edited entry shows up as tampered and a deleted one breaks the chain, including the most recent.
- **Brazilian fiscal files.** A DANFE is rendered straight from the NF-e XML; DOCX/XLSX get a PDF preview through headless LibreOffice.

## Screens

All captured from the public demo with its fictitious data.

| | |
|---|---|
| ![Dashboard with document counters, uploads chart and documents per folder](.github/readme/dashboard.png) | ![Documents with the folder tree and the details panel](.github/readme/documents.png) |
| **Dashboard** (dark theme) | **Documents** with the details panel (light theme) |
| ![DANFE rendered from a fictitious NF-e XML](.github/readme/danfe.png) | ![Audit trail integrity check reporting an intact chain](.github/readme/audit-chain.png) |
| **DANFE** rendered straight from the NF-e XML | **Audit trail check**: every event re-verified against the hash chain |

## Architecture

```mermaid
flowchart LR
  B[Browser<br/>React + Vite + Tailwind] -->|HTTPS + JWT| A[FastAPI on Fly.io]
  B -->|presigned PUT/GET| R[(Cloudflare R2<br/>files)]
  A -->|asyncpg, RLS per request| P[(Supabase Postgres<br/>ltree, pg_trgm, unaccent)]
  A -->|verifies tokens| S[Supabase Auth]
  A --> W[Workers<br/>OCR · retention · stats]
  W --> P
  W --> R
```

- The API forwards the user's JWT claims to Postgres (`set_config('request.jwt.claims')` + `SET LOCAL role authenticated`) inside one transaction per request, so the RLS policies apply to every query.
- Uploads go straight from the browser to R2 with presigned URLs (multipart from 20 MB, in 10 MB parts); the API only confirms the real size and computes the SHA-256 for deduplication.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript (strict), Vite 6, Tailwind CSS 4, pdf.js |
| Backend | Python 3.11, FastAPI, asyncpg, python-jose |
| Data | Supabase (Postgres + Auth), 35 SQL migrations |
| Files | Cloudflare R2 (S3 API) |
| Processing | Tesseract OCR, LibreOffice headless |
| Hosting | Vercel (frontend), Fly.io (API) |

## Running locally

Requirements: Node 20+, Python 3.11+, Docker and the Supabase CLI.

```bash
supabase start                      # local Postgres + Auth, applies supabase/migrations
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                # fill in the keys printed by `supabase start`
python -m app.seed.demo_data        # 3 fictitious companies with documents
uvicorn app.main:app --reload --port 8000
```

```bash
cd frontend
cp .env.example .env
npm ci
npm run dev                         # http://localhost:5173
```

Without R2 credentials the API stores files on local disk (development mode).

## Tests

- `backend/tests`: 13 pytest integration tests (RLS, including column limits on the user's own profile and the activity log partitions; permissions; OCR sync; folder move; share links, with permanent deletion of a version-pinned link and the public link role; and the audit chain catching an edited, deleted or truncated event and refusing a company the caller has no access to) against a real local Supabase.
- `frontend/e2e`: 4 Playwright specs (demo login, identity switch, PDF preview, search deep link).
- CI runs both on every push to `main`.

## Status and limitations

- The public demo runs on free or near-free tiers: the API on Fly.io stops when idle, so the first visit can take a few seconds while it starts. A daily job keeps the Supabase Free project from pausing.
- The interface is in Brazilian Portuguese only.
- The demo data is fictitious: company names are made up and the three CNPJs fail the check-digit validation, so they cannot belong to a real company.

## License

[MIT](LICENSE)
