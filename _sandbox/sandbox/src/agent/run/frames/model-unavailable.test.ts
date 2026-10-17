import { modelUnavailableFrame } from "../error-frames.js";

/* A routed refusal that is really a spent allowance must not be filed as the model being off the plan: that hides the
   model for a day, where a sibling refused by the same limit was held for its reset and re-run (2026-10-17). */

test("a spent allowance in a refusal envelope goes out as the spent allowance it is, in the vendor's words", () => {
    const kimi =
        "Failed to authenticate. API Error: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.";
    expect(modelUnavailableFrame("kimi-k3-256k", kimi)).toEqual({ kind: "error", code: "rate_limit", message: kimi });
});

test("a plan that lacks the model is still the model being unavailable", () => {
    expect(modelUnavailableFrame("opus", "Your plan does not have access to this model.")).toMatchObject({ code: "model-unavailable" });
});
