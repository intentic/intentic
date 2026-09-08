import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { codexInstructionConfig, instructionsPath } from "./codex-instructions.js";

// What Codex is actually sent when this sandbox has a system prompt. Integration, not unit: the replacement is a path,
// so an in-memory seam would prove nothing about whether the model ever sees the file.

test("nothing to say sends no config at all", async () => {
    // An empty object, not undefined-valued keys, which would reach thread/start as real overrides.
    expect(await codexInstructionConfig({}, mkdtempSync(join(tmpdir(), "codex-instr-")))).toEqual({});
});

test("a replacement is written to disk and named by path; an addition rides as text", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-instr-"));

    const config = await codexInstructionConfig({ systemPrompt: "You write release notes.", systemAppend: "Be brief." }, home);

    const path = config["model_instructions_file"];
    expect(typeof path).toBe("string");
    expect(await readFile(path as string, "utf8")).toBe("You write release notes.");
    // The append is a string key: Codex takes it as an extra developer message, no file involved.
    expect(config["developer_instructions"]).toBe("Be brief.");
});

// Content-addressed, so concurrent turns sharing one CODEX_HOME can't overwrite each other's prompt file between write
// and read; same text same path, different text different path.
test("the same prompt is the same file, a different prompt a different one", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-instr-"));

    const first = await codexInstructionConfig({ systemPrompt: "One." }, home);
    const again = await codexInstructionConfig({ systemPrompt: "One." }, home);
    const other = await codexInstructionConfig({ systemPrompt: "Two." }, home);

    expect(first["model_instructions_file"]).toBe(again["model_instructions_file"]);
    expect(first["model_instructions_file"]).not.toBe(other["model_instructions_file"]);
    expect(first["model_instructions_file"]).toBe(instructionsPath(home, "One."));
});

// Empty string is a legal prompt (the owner emptied the box), different from never asking for a replacement at all;
// it's written and sent like any other.
test("an emptied prompt still replaces, with nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-instr-"));

    const config = await codexInstructionConfig({ systemPrompt: "" }, home);

    expect(config["model_instructions_file"]).toBe(instructionsPath(home, ""));
    expect(await readFile(config["model_instructions_file"] as string, "utf8")).toBe("");
});
