# WHAT `fileq render` DRAWS WITH, so an agent can look at the deck, report or spreadsheet it just made before a
# person opens it (_sandbox/fileq, src/lib/render/convert.ts):
#   LibreOffice (headless, no GUI)  lays a docx, pptx, xlsx, odt, odp or ods out to PDF: impress, writer and calc,
#                                    the three halves a deliverable comes in.
#   poppler-utils                   pdftoppm draws those PDF pages, and any PDF, to PNG; it is also the rasterizer
#                                    fileq's OCR tier hands the `ocr` command, where an image carries its models.
#   fonts-liberation, dejavu-core   Liberation is metric-compatible with Arial, Times New Roman and Courier New, so a
#                                    deck set in them breaks its lines where PowerPoint does; DejaVu covers the rest.
#                                    The browser pack carries Liberation too; installing it twice is a no-op.
#
# A PACK, AND IN NO PROFILE. It is the heaviest thing a sandbox could ask for short of a GPU runtime: 87 packages on
# trixie, ~99 MB to download and ~335 MB installed, nearly all of it LibreOffice's core. Only a session that produces
# office documents needs it, and every published image would carry it for all the ones that do not. Without it
# `fileq check` still lints the structure; `fileq render` says what is missing and names the command that asks for
# this pack (`environment propose office --pack`), which files this fragment as a draft the owner approves, and the
# sandbox has it after the rebuild. A PDF alone would need only poppler (~18 MB), but the documents agents make for
# people are decks and reports, and those need the layout engine.
#
# The -nogui packages are LibreOffice's headless builds: no X11 or GTK stack, which the full packages would pull in
# for a converter that never opens a window.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-impress-nogui libreoffice-writer-nogui libreoffice-calc-nogui \
        poppler-utils fonts-liberation fonts-dejavu-core \
    && command -v soffice && pdftoppm -v
