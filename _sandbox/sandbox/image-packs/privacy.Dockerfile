# Offline PP-OCRv6 image/PDF reading (Apache-2.0) and Polish HerBERT NER (CC-BY-4.0), fetched at pinned revisions during image build.
# HerBERT: ArkadiuszPawlak/pczarnik-herbert-ner-polish-pii, from pczarnik/herbert-base-ner and clarin-pl/kpwr-ner.
# Share the daemon's ONNX runtime and OCR CLI; avoid a second Python/Paddle runtime. poppler supplies scanned PDF pages.
# No profile bakes this pack; shield policy requests an approved overlay rebuild and holds unchecked outbound images until ready.
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
