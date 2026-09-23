import { CLAUDE_SEED_MODELS } from "@intentic/sandbox-contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intenticPromptOf, missedCuts } from "./intentic-prompt.js";
import { presetSystemPrompt } from "./preset-prompt.js";

// Against the installed CLI, so an SDK bump that rewords a cut fails here instead of quietly keeping that text in
// every intentic turn. Each model gets its own variant, and no one variant carries every cut.
const MODELS: readonly (string | undefined)[] = [undefined, ...CLAUDE_SEED_MODELS.map((model) => model.id)];

test("every cut still finds its text in some model's preset, and none of it survives", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "intentic-prompt-"));
    const presets = await Promise.all(MODELS.map((model) => presetSystemPrompt(cwd, model)));
    const missedEverywhere = presets.map(({ text }) => missedCuts(text)).reduce((left, right) => left.filter((cut) => right.includes(cut)));
    expect(missedEverywhere).toEqual([]);
    // What was cut is gone: a derived prompt is one no cut finds anything in.
    for (const { text } of presets) {
        expect(missedCuts(intenticPromptOf(text))).toEqual(missedCuts(""));
    }
});
