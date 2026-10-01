import { existsSync } from "node:fs";
import { join } from "node:path";

// Where PaddleOCR's PP-OCRv6 models are installed, and whether they are: the `privacy` image pack puts them under
// /opt/privacy-models, and PRIVACY_OCR_MODEL_DIR points elsewhere (a test, a checkout reading downloaded models). Its own
// module, free of the runtime and the image decoder, so asking whether the reader is there costs no native library.

export const PP_OCR_DIR_NAME = "pp-ocrv6";
export const ocrModelDir = (): string => process.env["PRIVACY_OCR_MODEL_DIR"] ?? join("/opt/privacy-models", PP_OCR_DIR_NAME);

export const DETECTOR = ["det", "inference.onnx"] as const;
export const RECOGNIZER = ["rec", "inference.onnx"] as const;
// The recognizer's own config, which carries its character dictionary.
export const RECOGNIZER_CONFIG = ["rec", "inference.yml"] as const;

export const ocrInstalled = (dir: string = ocrModelDir()): boolean =>
    [DETECTOR, RECOGNIZER, RECOGNIZER_CONFIG].every((path) => existsSync(join(dir, ...path)));
