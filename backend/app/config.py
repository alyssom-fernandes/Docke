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

    # Fase 11.1: sobe de 50MB pra 200MB — o limite de 50MB era o teto real
    # ANTES do multipart upload existir (um único PUT gigante era frágil em
    # rede instável). Com upload em partes de 10MB, 200MB deixou de ser
    # arriscado — resolve o pedido original de 200MB+ do backlog.
    MAX_FILE_SIZE_BYTES: int = 209_715_200  # 200MB

    ALLOWED_EXTENSIONS: list[str] = [
        "pdf", "xlsx", "xls", "csv", "docx", "doc",
        "xml", "jpg", "jpeg", "png", "gif", "txt",
    ]

    JWT_SECRET: str = "super-secret-jwt-token-with-at-least-32-characters-long"

    CORS_ORIGINS: str = "http://localhost:5173"

    # Modo demo: e-mail é fixo (não é segredo), senha SEMPRE vem de env var/Fly
    # secret — nunca hardcoded em código-fonte (incidente real: GitGuardian
    # detectou a senha commitada quando ela estava direto no .tsx/.py).
    DEMO_EMAIL: str = "demo@docke.app"
    DEMO_PASSWORD: str = ""
    DEMO_RESET_INTERVAL_HOURS: int = 24

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
