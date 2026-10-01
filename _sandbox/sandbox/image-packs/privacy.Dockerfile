# WHAT THE PRIVACY SHIELD READS WITH, beyond the text it masks on its own (src/privacy/):
#   PaddleOCR PP-OCRv6          the text reader (src/ocr/): PaddleOCR 3.7's medium detector and recognizer, in the
#                               ONNX form PaddlePaddle publishes them, run in the daemon's own process by
#                               onnxruntime-node, which the image already carries. It reads the words off an image
#                               bound for an untrusted provider so the stretches holding personal data can be painted
#                               over with their tokens before it is sent (`images: "mask"`), and reads a scanned PDF's
#                               pages. One recognizer covers 50 languages, Polish among them (ą, ę, ł, ż are in its
#                               dictionary). Apache-2.0. Det ~59 MB, rec ~73 MB. The same reader is the `ocr` command.
#   poppler-utils               pdftoppm draws a scanned PDF's pages for the reader; pdftotext, its text layer, is
#                               already in the base image.
#   the HerBERT name model      a Polish named-entity model fine-tuned for personal data (PERSON, and ADDRESS kept
#                               only where it carries a house number), int8-quantized ONNX, ~125 MB, run offline by
#                               transformers.js behind `names: "model"` (src/privacy/ner.ts). CC-BY-4.0, from
#                               ArkadiuszPawlak/pczarnik-herbert-ner-polish-pii, itself pczarnik/herbert-base-ner
#                               trained on clarin-pl/kpwr-ner.
#
# Every model is pinned to a repository revision and its digest checked: a model that changed under the same name
# would change what is masked without anybody deciding to. Tesseract was the reader until 2026-10; PP-OCRv6 replaced it
# because it reads screenshots, photos and Polish diacritics far better and says where on the image each character is,
# which painting over a value needs. The PaddleOCR Python package was the other way to run it, rejected: it would bring
# a second runtime (PaddlePaddle or paddlex with its own onnxruntime) and a Python process per image.
#
# A PACK, AND IN NO PROFILE. The shield is off unless the owner turns it on. The daemon composes this pack into the
# overlay by itself while the shield's policy asks for a reader (on or watching, with images masked or names found by
# the model: src/environment/privacy-pack.ts), and the owner approves the rebuild on the Environment card. Until then an
# image bound for an untrusted provider is held back, since it cannot be checked. Fetched over plain HTTPS from the
# Hugging Face resolve endpoint, the way the base image fetches its other pinned artifacts, never at run time.
ARG PRIVACY_NER_REVISION=26cc98018d73ae0c815b8274612f42b6002191e7
ARG PRIVACY_OCR_DET_REVISION=61323801669c338b7891481ec7bac61ce31b576a
ARG PRIVACY_OCR_REC_REVISION=50c7eacafc52fa7bcf4194e8cd08e46f8558504b
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && ocr=/opt/privacy-models/pp-ocrv6 \
    && mkdir -p "$ocr/det" "$ocr/rec" \
    && det="https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_det_onnx/resolve/${PRIVACY_OCR_DET_REVISION}" \
    && rec="https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/${PRIVACY_OCR_REC_REVISION}" \
    && curl -fsSL --retry 3 -o "$ocr/det/inference.onnx" "$det/inference.onnx" \
    && curl -fsSL --retry 3 -o "$ocr/det/inference.yml" "$det/inference.yml" \
    && curl -fsSL --retry 3 -o "$ocr/rec/inference.onnx" "$rec/inference.onnx" \
    && curl -fsSL --retry 3 -o "$ocr/rec/inference.yml" "$rec/inference.yml" \
    && printf '%s  %s\n' \
        eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1 "$ocr/det/inference.onnx" \
        7298d5ead546584af2504d03355f881ac7a7bc0eb1e282d3e159277c1d0af871 "$ocr/det/inference.yml" \
        9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba "$ocr/rec/inference.onnx" \
        991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129 "$ocr/rec/inference.yml" \
        | sha256sum -c - \
    && model=/opt/privacy-models/herbert-ner-pl \
    && mkdir -p "$model/onnx" \
    && base="https://huggingface.co/ArkadiuszPawlak/pczarnik-herbert-ner-polish-pii/resolve/${PRIVACY_NER_REVISION}" \
    && for file in config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do \
           curl -fsSL --retry 3 -o "$model/$file" "$base/$file"; \
       done \
    && curl -fsSL --retry 3 -o "$model/onnx/model_quantized.onnx" "$base/onnx/model_quantized.onnx" \
    && test "$(stat -c %s "$model/onnx/model_quantized.onnx")" -gt 100000000
