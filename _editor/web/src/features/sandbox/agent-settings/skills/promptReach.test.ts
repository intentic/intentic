import { capabilitiesOf, PROVIDERS } from "@intentic/sandbox-contract";
import { promptReach, spokenList } from "./promptReach";

/* The sentence under the System prompt control, asserted by SHAPE rather than by its words. */

test("every provider the composer offers is named, and named once", () => {
    const { replaces, adds, ignores } = promptReach();

    expect([...replaces, ...adds, ...ignores].toSorted()).toEqual(PROVIDERS.map((provider) => provider.label).toSorted());
});

test("each provider is grouped by what its own runtime does with the prompt", () => {
    const groups = promptReach();
    const byInstructions = { replace: groups.replaces, append: groups.adds, none: groups.ignores };

    for (const provider of PROVIDERS) {
        const group = byInstructions[capabilitiesOf(provider.value, `native`).instructions];
        expect(group, `${provider.label} on its own runtime`).toContain(provider.label);
    }
});

test("a list reads the way somebody would say it", () => {
    expect(spokenList([`Claude Code`])).toBe(`Claude Code`);
    expect(spokenList([`Claude Code`, `Codex`])).toBe(`Claude Code and Codex`);
    expect(spokenList([`Claude Code`, `Codex`, `Kimi Code`])).toBe(`Claude Code, Codex and Kimi Code`);
    // Nothing rather than a dangling conjunction, for the group a future record could empty.
    expect(spokenList([])).toBe(``);
});
