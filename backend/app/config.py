from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    SUPABASE_URL: str = "http://localhost:54321"
    SUPABASE_ANON_KEY: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:54322/postgres"

    R2_ACCOUNT_ID: str = ""
    R2_ACCESS_KEY_ID: str = ""
    R2_SECRET_ACCESS_KEY: str = ""
    R2_BUCKET_NAME: str = "docke-dev"
    R2_ENDPOINT_URL: str = ""

    ENABLE_OCR_WORKER: bool = True

    MAX_FILE_SIZE_BYTES: int = 52_428_800  # 50MB

    ALLOWED_EXTENSIONS: list[str] = [
        "pdf", "xlsx", "xls", "csv", "docx", "doc",
        "xml", "jpg", "jpeg", "png", "gif", "txt",
    ]

    JWT_SECRET: str = "super-secret-jwt-token-with-at-least-32-characters-long"

    CORS_ORIGINS: str = "http://localhost:5173"

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",")]

    @property
    def asyncpg_url(self) -> str:
        """Converte URL no formato SQLAlchemy para o formato nativo do asyncpg."""
        return (
            self.DATABASE_URL
            .replace("postgresql+asyncpg://", "postgresql://", 1)
            .replace("asyncpg://", "postgresql://", 1)
        )


settings = Settings()
