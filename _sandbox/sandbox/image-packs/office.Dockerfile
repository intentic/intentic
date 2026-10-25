# Optional fileq rendering tools: headless LibreOffice lays out office documents; poppler rasterizes PDF pages for viewing/OCR.
# Liberation preserves common Office font metrics; DejaVu provides fallback glyphs. Use -nogui packages to avoid an unused desktop stack.
# No published profile includes this heavy pack; fileq check still works without it and render names the pack/rebuild needed.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-impress-nogui libreoffice-writer-nogui libreoffice-calc-nogui \
        poppler-utils fonts-liberation fonts-dejavu-core \
    && command -v soffice && pdftoppm -v
