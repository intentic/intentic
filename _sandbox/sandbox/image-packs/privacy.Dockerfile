# WHAT THE PRIVACY SHIELD READS WITH, beyond the text it masks on its own (src/privacy/):
#   tesseract-ocr (+ pol, eng)  reads an image, or a scanned PDF's pages, to text on this machine, so an image bound
#                               for an untrusted provider can go as masked text instead of being withheld
#                               (`images: "read"`; src/privacy/readers.ts). Polish first: the shield's owners write
#                               Polish documents, and English data alone misreads ą, ę, ł and ż.
#   poppler-utils               pdftoppm draws a scanned PDF's pages for tesseract; pdftotext, its text layer, is
#                               already in the base image.
#   the HerBERT name model      a Polish named-entity model fine-tuned for personal data (PERSON, and ADDRESS kept
#                               only where it carries a house number), int8-quantized ONNX, ~125 MB, run offline by
#                               transformers.js behind `names: "model"` (src/privacy/ner.ts). CC-BY-4.0, from
#                               ArkadiuszPawlak/pczarnik-herbert-ner-polish-pii, itself pczarnik/herbert-base-ner
#                               trained on clarin-pl/kpwr-ner. Pinned to a revision: a model that changed under the
#                               same name would change what is masked without anybody deciding to.
#
# A PACK, AND IN NO PROFILE. The shield is off unless the owner turns it on, and works without this pack (the
# dictionary finds names, an image is withheld rather than read). The daemon composes it into the overlay by itself
# while the shield's policy asks for a reader (on or watching, with images read or names found by the model:
# src/environment/privacy-pack.ts), and the owner approves the rebuild on the Environment card. Fetched over plain
# HTTPS from the Hugging Face resolve endpoint, the way the base image fetches its other pinned artifacts, never at
# run time.
ARG PRIVACY_NER_REVISION=26cc98018d73ae0c815b8274612f42b6002191e7
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-pol tesseract-ocr-eng poppler-utils \
    && tesseract --list-langs | grep -qx pol \
    && model=/opt/privacy-models/herbert-ner-pl \
    && mkdir -p "$model/onnx" \
    && base="https://huggingface.co/ArkadiuszPawlak/pczarnik-herbert-ner-polish-pii/resolve/${PRIVACY_NER_REVISION}" \
    && for file in config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do \
           curl -fsSL --retry 3 -o "$model/$file" "$base/$file"; \
       done \
    && curl -fsSL --retry 3 -o "$model/onnx/model_quantized.onnx" "$base/onnx/model_quantized.onnx" \
    && test "$(stat -c %s "$model/onnx/model_quantized.onnx")" -gt 100000000
