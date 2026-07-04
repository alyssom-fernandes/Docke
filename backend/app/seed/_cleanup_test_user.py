"""Script de limpeza — uso único. Remove a conta de teste do Supabase Auth. Apague após usar."""
from __future__ import annotations

import asyncio

import httpx

from app.config import settings

TEST_USER_ID = "1cc6b0cc-f0d8-469d-a7cc-a32ad9df75df"


async def main() -> None:
    async with httpx.AsyncClient() as client:
        resp = await client.delete(
            f"{settings.SUPABASE_URL}/auth/v1/admin/users/{TEST_USER_ID}",
            headers={
                "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=10.0,
        )
        print(f"Status: {resp.status_code}")
        print(resp.text)


if __name__ == "__main__":
    asyncio.run(main())
