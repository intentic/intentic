// Marks must not be guessed from a skill's name: a renamed connection would lose its brand, and a slug that's
// also an ordinary word (`linear`) must not borrow a logo it doesn't own.
import type { CapabilitySummary, SkillOrigin, SkillSummary } from "@intentic/api-contract";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { type SkillSources, skillVisual } from "./skillVisual";

const skill = (name: string, origin: SkillOrigin, owner?: string): SkillSummary => ({
    id: name,
    name,
    description: `Use when asked.`,
    origin,
    owner,
    enabled: true,
    switchable: false,
    editable: false,
    removable: false,
});

const capability = (id: string, kind: string, config: Record<string, string> = {}): CapabilitySummary =>
    ({ id, kind, status: { state: `active` }, config }) as CapabilitySummary;

// Only the manifest fields the marks read; matches the extension facets test's fixture.
const extension = (name: string, manifest: Partial<ExtensionManifest>): ExtensionSummary =>
    ({ id: `intentic.${name}`, manifest: { publisher: `intentic`, name, version: `1.0.0`, ...manifest } }) as ExtensionSummary;

const sources = (over: Partial<SkillSources> = {}): SkillSources => ({ capabilities: [], extensions: [], ...over });

// Real connectors cards: Reddit's brand, and a Windows PC glyph since Microsoft has no logo in the set.
const connectors = extension(`connectors`, {
    contributes: {
        capabilities: [
            { kind: `browser`, id: `reddit`, catalog: { name: `Reddit`, logo: `reddit`, description: ``, category: `communication` } },
            { kind: `host`, id: `windows`, catalog: { name: `Windows PC`, icon: `desktop`, description: ``, category: `devices` } },
        ],
    } as ExtensionManifest[`contributes`],
});

it(`gives a connection the mark of the card it came from, whatever the owner named it`, () => {
    // Named `reddit-work`, not `reddit`; the mark must still come from the card, not the name.
    const visual = skillVisual(skill(`reddit-work`, `capability`, `reddit-work`), {
        capabilities: [capability(`reddit-work`, `browser`, { platform: `reddit` })],
        extensions: [connectors],
    });
    expect(visual.logo).toBe(`reddit`);
});

it(`takes the card's glyph where the card itself has no brand to lend`, () => {
    // Card says `desktop` (a device); the capability-origin fallback would otherwise say "connection".
    const visual = skillVisual(skill(`radarsu-omen`, `capability`, `radarsu-omen`), {
        capabilities: [capability(`radarsu-omen`, `host`, { platform: `windows` })],
        extensions: [connectors],
    });
    expect(visual).toEqual({ logo: undefined, icon: `desktop` });
});

it(`answers for a kind whose cards the platform ships itself`, () => {
    // SSH has one static card and glyph; a remote-machine skill should wear it, not the generic link icon.
    expect(skillVisual(skill(`ssh`, `capability`, `ops-box`), sources({ capabilities: [capability(`ops-box`, `ssh`)] })).icon).toBe(`server`);
});

it(`draws an extension's skills as the extension itself is drawn`, () => {
    const installed = [extension(`discord`, { logo: `discord` }), extension(`documentation`, { icon: `question-circle` })];
    // Origin glyph alone would give both the same icon; each must draw its own extension's mark.
    expect(skillVisual(skill(`discord`, `extension`, `discord`), sources({ extensions: installed })).logo).toBe(`discord`);
    expect(skillVisual(skill(`documenting`, `extension`, `documentation`), sources({ extensions: installed })).icon).toBe(`question-circle`);
});

it(`falls back to the name when there is no owner to ask`, () => {
    // The baked tools and the reader's own skills: nothing owns them, so the words are all there is.
    expect(skillVisual(skill(`lsp`, `builtin`), sources()).icon).toBe(`code`);
    expect(skillVisual(skill(`iq`, `builtin`, `Code search`), sources()).icon).toBe(`search`);
    // A word, not the whole name: nobody spells these the same way twice.
    expect(skillVisual(skill(`figma-export`, `own`), sources()).logo).toBe(`figma`);
});

it(`never lends an ordinary word somebody's brand`, () => {
    // `linear` is also a real slug (the tracker); honoring it would put that brand on a maths skill.
    expect(skillVisual(skill(`linear-algebra`, `own`), sources()).logo).toBeUndefined();
});

it(`lands on the origin's own glyph only when nothing else recognises anything`, () => {
    // Named after nothing; origin is genuinely all there is to say about this row.
    expect(skillVisual(skill(`scratch`, `dropped`), sources())).toEqual({ icon: `file` });
    // Sources not yet arrived; must render as the generic link icon, not a hole.
    expect(skillVisual(skill(`vendor-tool`, `capability`, `vendor-tool`), sources())).toEqual({ icon: `link` });
});
