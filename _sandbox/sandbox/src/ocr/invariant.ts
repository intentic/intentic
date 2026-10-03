import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: OCR is a pure reader. It turns an image into text with models read from disk and keeps nothing between calls, so there is no record here for another to disagree with; whether the models are installed is answered by `ocr --check` and the privacy pack. */

export const owner = "ocr";

export const checks = (): readonly InvariantCheck[] => [];
