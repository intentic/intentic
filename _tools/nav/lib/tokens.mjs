// Costs are tokens, not lines: stripping comments shrinks line count while densifying what remains, which lines can't
// see. The estimator is @intentic/base's, the one every budget in the product uses (fitted to o200k_base per piece;
// `nav calibrate` checks it stays in real BPE's characters-per-token band); an absolute count is close, a delta is real.
import { estimateTokens } from "../../base/src/text/tokens.ts";

export { estimateTokens };

// The real tokenizer, loaded lazily and by name so a checkout without it never hits an import error.
let realEncoder;
const loadReal = async () => {
    if (realEncoder !== undefined) {
        return realEncoder;
    }
    try {
        const mod = await import("gpt-tokenizer/model/gpt-4o");
        realEncoder = (text) => mod.encode(text).length;
    } catch {
        realEncoder = null;
    }
    return realEncoder;
};

// Picks a counter for this run; returns the function and the label recorded in the output, so a number's tokenizer is
// always known later.
export const tokenCounter = async () => {
    if (process.env.NAV_TOKENIZER === "real") {
        const real = await loadReal();
        if (real) {
            return { count: real, label: "gpt-tokenizer/o200k_base" };
        }
        process.stderr.write("nav: NAV_TOKENIZER=real but gpt-tokenizer is not installed; using the estimator\n");
    }
    return { count: estimateTokens, label: "estimator/v2" };
};
