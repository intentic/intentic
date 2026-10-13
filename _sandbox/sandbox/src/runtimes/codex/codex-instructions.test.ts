import { codexInstructions, PROJECT_DOC_CONFIG } from "./codex-instructions.js";

// What Codex is sent when this sandbox has a system prompt: the two first-class thread fields, no file on disk.

test("nothing to say sends neither field", () => {
    // An empty object, not undefined-valued keys, which would reach thread/start as real overrides.
    expect(codexInstructions({})).toEqual({});
});

test("a replacement rides as the base prompt, an addition as the developer message", () => {
    expect(codexInstructions({ systemPrompt: "You write release notes.", systemAppend: "Be brief." })).toEqual({
        base: "You write release notes.",
        developer: "Be brief.",
    });
});

// Empty string is a legal prompt (the owner emptied the box), different from never asking for a replacement at all.
test("an emptied prompt still replaces, with nothing", () => {
    expect(codexInstructions({ systemPrompt: "" })).toEqual({ base: "" });
});

// The daemon composes AGENTS.md into the developer message already; Codex's own loader would add it a second time.
test("Codex's own AGENTS.md loader is given no budget", () => {
    expect(PROJECT_DOC_CONFIG).toEqual({ project_doc_max_bytes: 0 });
});
