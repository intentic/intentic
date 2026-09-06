import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { codexInstructionConfig, instructionsPath } from "./codex-instructions.js";

/* WHAT CODEX IS ACTUALLY SENT when this sandbox has a system prompt, and the file that has to exist for the
 * replacement half of it to mean anything.
 *
 * Integration rather than unit because the replacement is a PATH: Codex reads the prompt out of a file, so a
 * test against an in-memory seam would assert the config key and prove nothing about whether the model would
 * ever see the text. */

test("nothing to say sends no config at all", async () => {
    // The ordinary turn: no custom prompt, nothing to add. Codex must be left exactly as it was, which means an
    // EMPTY object rather than keys carrying undefined: those would reach thread/start as real overrides.
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

/* CONTENT-ADDRESSED, which is the whole reason the file is safe to write. Several turns plan concurrently
 * against one CODEX_HOME; a fixed filename would have them overwriting each other between the write and the
 * read, and the loser would run on the winner's prompt. Same text ⇒ same path (so the write is idempotent and
 * the steady state is one file per distinct prompt); different text ⇒ different path, so they cannot collide. */
test("the same prompt is the same file, a different prompt a different one", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-instr-"));

    const first = await codexInstructionConfig({ systemPrompt: "One." }, home);
    const again = await codexInstructionConfig({ systemPrompt: "One." }, home);
    const other = await codexInstructionConfig({ systemPrompt: "Two." }, home);

    expect(first["model_instructions_file"]).toBe(again["model_instructions_file"]);
    expect(first["model_instructions_file"]).not.toBe(other["model_instructions_file"]);
    expect(first["model_instructions_file"]).toBe(instructionsPath(home, "One."));
});

// "" is a legal custom prompt: the owner emptied the box, and it means no base prompt at all. That is a
// different turn from one that never asked for a replacement, so it is written and sent like any other.
test("an emptied prompt still replaces, with nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-instr-"));

    const config = await codexInstructionConfig({ systemPrompt: "" }, home);

    expect(config["model_instructions_file"]).toBe(instructionsPath(home, ""));
    expect(await readFile(config["model_instructions_file"] as string, "utf8")).toBe("");
});
