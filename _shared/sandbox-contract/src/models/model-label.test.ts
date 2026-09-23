import { humanizeModelId } from "./model-label.js";

// One humanizer for every id no catalog names, on both sides of the wire.
test("title-cases the tokens and keeps vendor acronyms upper", () => {
    expect(humanizeModelId("gpt-5-codex")).toBe("GPT 5 Codex");
    expect(humanizeModelId("gpt-oss-120b-medium")).toBe("GPT OSS 120b Medium");
    expect(humanizeModelId("o3-mini")).toBe("O3 Mini");
    expect(humanizeModelId("grok-4-fast")).toBe("Grok 4 Fast");
    expect(humanizeModelId("gemini-3.1-pro-low")).toBe("Gemini 3.1 Pro Low");
    expect(humanizeModelId("opus")).toBe("Opus");
});

test("reads a version spelled across segments as the version a person says", () => {
    expect(humanizeModelId("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(humanizeModelId("gpt-4-1")).toBe("GPT 4.1");
    expect(humanizeModelId("qwen-2-5-72b")).toBe("Qwen 2.5 72b");
});

test("drops a release stamp, and leaves a build number the vendor spelled as its own", () => {
    expect(humanizeModelId("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(humanizeModelId("claude-3-5-sonnet-2024-10-22")).toBe("Claude 3.5 Sonnet");
    expect(humanizeModelId("grok-4.20-0309-reasoning")).toBe("Grok 4.20 0309 Reasoning");
});
