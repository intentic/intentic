// WHAT THE COLUMN LOOKED LIKE BEFORE: thirteen rows, six glyphs between them, eight of which were the same chain
// link, so telling the Discord cheatsheet from the GitHub one meant reading the list rather than glancing down it.
// What is pinned here is the two ways a mark ladder quietly stops earning that back: asking the skill's NAME for
// something its owner already knows (a renamed connection then loses its brand), and honouring a slug that happens
// to exist for an ordinary English word.
import type { CapabilitySummary, SkillOrigin, SkillSummary } from "@intentic-app/api-contract";
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

// Only the halves the marks are read out of: the same partial-manifest fixture the extension facets test uses.
const extension = (name: string, manifest: Partial<ExtensionManifest>): ExtensionSummary =>
    ({ id: `intentic.${name}`, manifest: { publisher: `intentic`, name, version: `1.0.0`, ...manifest } }) as ExtensionSummary;

const sources = (over: Partial<SkillSources> = {}): SkillSources => ({ capabilities: [], extensions: [], ...over });

// The connectors extension's own cards, as they ship: a brand for Reddit, a glyph for the Windows PC (Microsoft's
// mark is not in the icon set at all, which is exactly the case a name-keyed table cannot know about).
const connectors = extension(`connectors`, {
    contributes: {
        capabilities: [
            { kind: `browser`, id: `reddit`, catalog: { name: `Reddit`, logo: `reddit`, description: ``, category: `communication` } },
            { kind: `host`, id: `windows`, catalog: { name: `Windows PC`, icon: `desktop`, description: ``, category: `machines` } },
        ],
    } as ExtensionManifest[`contributes`],
});

it(`gives a connection the mark of the card it came from, whatever the owner named it`, () => {
    // The instance is called `reddit-work` because its owner has two Reddit accounts. Nothing in that name is a
    // brand, so this is the case the whole top tier exists for.
    const visual = skillVisual(skill(`reddit-work`, `capability`, `reddit-work`), {
        capabilities: [capability(`reddit-work`, `browser`, { platform: `reddit` })],
        extensions: [connectors],
    });
    expect(visual.logo).toBe(`reddit`);
});

it(`takes the card's glyph where the card itself has no brand to lend`, () => {
    // A Windows PC named after the machine. Its card says `desktop`, which is a computer, where the origin's
    // fallback would have said "connection", i.e. what every other row on the list also says.
    const visual = skillVisual(skill(`radarsu-omen`, `capability`, `radarsu-omen`), {
        capabilities: [capability(`radarsu-omen`, `host`, { platform: `windows` })],
        extensions: [connectors],
    });
    expect(visual).toEqual({ logo: undefined, icon: `desktop` });
});

it(`answers for a kind whose cards the platform ships itself`, () => {
    // SSH has no contribution behind it and no discriminator: one static card, one glyph, and a skill from a
    // remote machine should wear it rather than the generic link.
    expect(skillVisual(skill(`ssh`, `capability`, `ops-box`), sources({ capabilities: [capability(`ops-box`, `ssh`)] })).icon).toBe(`server`);
});

it(`draws an extension's skills as the extension itself is drawn`, () => {
    const installed = [extension(`discord`, { logo: `discord` }), extension(`documentation`, { icon: `question-circle` })];
    // Two extensions, two marks, where the origin glyph gave both of them the same slider.
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
    // `linear` IS a slug: the issue tracker, so honouring it would put a project-management logo on a maths
    // skill and read as a fact. The glyph tier reads as "no brand for this one", which claims nothing.
    expect(skillVisual(skill(`linear-algebra`, `own`), sources()).logo).toBeUndefined();
});

it(`lands on the origin's own glyph only when nothing else recognises anything`, () => {
    // A file somebody dropped in the folder, named after nothing. This is the one row whose origin is genuinely
    // all there is to say about it.
    expect(skillVisual(skill(`scratch`, `dropped`), sources())).toEqual({ icon: `file` });
    // And a connection whose lists have not arrived yet: late, not absent, so it must not render as a hole.
    expect(skillVisual(skill(`vendor-tool`, `capability`, `vendor-tool`), sources())).toEqual({ icon: `link` });
});
