// The guide panel renders whatever the catalog says, so the only thing worth pinning is that the split is
// faithful: no character of a step is lost, dropped or promoted to a literal it wasn't marked as.
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { connectedLinks, guideParts, guidePartsPrefixed, guideTokenUrl, isCommand } from "./credentialGuide";

const tile = (overrides: Partial<CapabilityCatalogEntry>): CapabilityCatalogEntry => ({
    id: `tile`,
    name: `Tile`,
    kind: `cli`,
    category: `communication`,
    description: `A tile.`,
    fields: [],
    ...overrides,
});

it(`marks backticked runs as literals and leaves the prose alone`, () => {
    expect(guideParts("Classic: generate a token with the `repo` scope (add `write:public_key` for ssh).")).toStrictEqual([
        { text: `Classic: generate a token with the`, literal: false },
        { text: ` repo`, literal: true },
        { text: ` scope (add`, literal: false },
        { text: ` write:public_key`, literal: true },
        { text: ` for ssh).`, literal: false },
    ]);
});

it(`keeps a line with no markup as a single run of prose`, () => {
    expect(guideParts(`Copy the token and paste it here.`)).toStrictEqual([{ text: `Copy the token and paste it here.`, literal: false }]);
});

// A third-party extension's guide is prose we never see before it renders. An unpaired backtick must not eat
// the rest of the sentence, and it must not silently vanish either.
it(`leaves an unpaired backtick in the prose`, () => {
    expect(guideParts("Open Settings → `Developer settings.")).toStrictEqual([{ text: "Open Settings → `Developer settings.", literal: false }]);
});

it(`loses nothing when a literal opens or closes the line`, () => {
    expect(guideParts("`Socket Mode` → toggle it on")).toStrictEqual([
        { text: `Socket Mode`, literal: true },
        { text: " → toggle it on", literal: false },
    ]);
    expect(guideParts("scope `connections:write`")).toStrictEqual([
        { text: `scope`, literal: false },
        { text: ` connections:write`, literal: true },
    ]);
});

it(`carries a scopes prefix gap onto the first catalog part`, () => {
    expect(guidePartsPrefixed(`Needs`, "`provision`: create sandboxes")).toStrictEqual([
        { text: `Needs`, literal: false },
        { text: ` provision`, literal: true },
        { text: `: create sandboxes`, literal: false },
    ]);
});

// A cloud's host is a fixed value of the chosen region, never a box, and the token link is still built from it.
it(`builds the token link from the host a chosen region pins`, () => {
    const posthog = tile({
        fields: [
            { key: `region`, label: `Region`, options: [{ value: `eu`, label: `EU` }, { value: `self`, label: `Self-hosted` }] },
            { key: `host`, label: `Host`, value: `https://eu.posthog.com`, when: `region == 'eu'` },
            { key: `host`, label: `URL`, when: `region == 'self'` },
        ],
        guide: { urlFromField: `host`, path: `/settings/user-api-keys` },
    });

    expect(guideTokenUrl(posthog, { region: `eu`, host: `` })).toBe(`https://eu.posthog.com/settings/user-api-keys`);
    expect(guideTokenUrl(posthog, { region: `self`, host: `https://ph.acme.dev/` })).toBe(`https://ph.acme.dev/settings/user-api-keys`);
    expect(guideTokenUrl(posthog, { region: `self`, host: `` })).toBeUndefined();
});

it(`offers a connected card's link once the connection holds what it is built from`, () => {
    const discord = tile({
        links: [{ label: `Add to your server`, url: `https://discord.com/oauth2/authorize?client_id=\${applicationId:uri}&scope=bot` }],
    });

    expect(connectedLinks(discord, { applicationId: `80351110224678912`, provider: `discord` })).toStrictEqual([
        { label: `Add to your server`, url: `https://discord.com/oauth2/authorize?client_id=80351110224678912&scope=bot` },
    ]);
    // Half a link is no link: an id the connection lacks leaves it out.
    expect(connectedLinks(discord, { provider: `discord` })).toStrictEqual([]);
    expect(connectedLinks(discord, { applicationId: ` `, provider: `discord` })).toStrictEqual([]);
});

it(`draws only a literal too long to be a menu item as a command to copy`, () => {
    expect(isCommand({ text: ` app=$(az ad app create --display-name Intentic --query appId -o tsv) && az ad sp create --id $app`, literal: true })).toBe(true);
    expect(isCommand({ text: ` Install to Workspace`, literal: true })).toBe(false);
    expect(isCommand({ text: ` and then this sentence runs on long enough to pass the length a command would reach`, literal: false })).toBe(false);
});
