import { capabilitiesOf, PROVIDERS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { promptReach, spokenList } from "./promptReach";

/* The sentence under the System prompt control, asserted by SHAPE rather than by its words: what this has to
 * guarantee is that every provider the composer offers ends up named somewhere, because a provider missing from
 * the line is exactly the silence the setting used to have. A provider added next month must land in a group
 * without anybody editing this file — so a hardcoded expectation of today's five would repeat the miss. */

test("every provider the composer offers is named, and named once", () => {
    const { replaces, adds } = promptReach();

    expect([...replaces, ...adds].toSorted()).toEqual(PROVIDERS.map((provider) => provider.label).toSorted());
});

test("each provider is grouped by what its own runtime does with the prompt", () => {
    const { replaces, adds } = promptReach();

    for (const provider of PROVIDERS) {
        const group = capabilitiesOf(provider.value, `native`).instructions === `replace` ? replaces : adds;
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
