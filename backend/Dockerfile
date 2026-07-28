FROM python:3.11-slim

# tesseract-ocr-por: pacote de idioma português, necessário para o OCR
# libgl1: dependência de runtime do opencv-python-headless
# libreoffice-writer/-calc (Fase 12.1): conversão headless de DOCX/XLSX→PDF
# pro pipeline de derivados — só os dois componentes usados (writer/calc),
# não o pacote "libreoffice" completo (evita Impress/Draw/Base desnecessários
# e mantém a imagem menor). Exige VM de pelo menos 2GB (fly.toml) — um
# processo soffice --headless sozinho já usa 300-500MB.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-por \
    libgl1 \
    libreoffice-writer \
    libreoffice-calc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
