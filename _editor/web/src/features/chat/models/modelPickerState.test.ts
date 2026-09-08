import { type AgentProvider, providerLabel } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { customEntryFor, familyGroups, filterEntries, lanesOf, type PickerEntry, pickerBlocks, pickerSections } from "./modelPickerState";
import { endpointProviders, LOCAL_MODELS_GROUP } from "../accounts/providerCatalog";

// The custom-model escape hatch: the one path that lets a user name a model no catalog has published yet, reachable
// during the window before catalogs adopt it.

// modelPicker imports conversation.ts for the live catalogs; stub its side-effects so the import is inert.
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxRequest: vi.fn() }));
vi.mock("./useChat-catalog", () => ({ loadProviderModels: vi.fn(async () => {}) }));

const entry = (provider: AgentProvider, value: string, label: string): PickerEntry => ({ key: `${provider}:${value}`, provider, value, label });

const CATALOG: readonly PickerEntry[] = [
    entry(`claude`, `opus`, `Opus`),
    entry(`claude`, `claude-opus-5`, `Claude Opus 5`),
    entry(`codex`, `gpt-5.1`, `GPT 5.1`),
];

test("offers a typed id no catalog row covers, so a model that already serves turns is reachable", () => {
    // Tier aliases lag a release and REST entries roll out slowly; the CLI accepts any string, so must the picker.
    expect(customEntryFor(CATALOG, `claude-opus-6`, `claude`)).toEqual({
        key: `claude:claude-opus-6`,
        provider: `claude`,
        value: `claude-opus-6`,
        label: `claude-opus-6`,
        description: `use as custom model id`,
    });
});

test("stays silent when the target provider already publishes the id, so it never competes with a real row", () => {
    expect(customEntryFor(CATALOG, `claude-opus-5`, `claude`)).toBeUndefined();
});

test("still offers an id only ANOTHER provider publishes: model ids are provider-scoped", () => {
    expect(customEntryFor(CATALOG, `gpt-5.1`, `claude`)?.provider).toBe(`claude`);
});

test("treats a multi-word query as a search, never an id", () => {
    expect(customEntryFor(CATALOG, `claude opus`, `claude`)).toBeUndefined();
});

test("stays silent for a bare search word, so browsing never grows a junk row per keystroke", () => {
    // Typing "fast" to find Grok 4 Fast must not also offer a model named `fast`; real ids are hyphenated.
    expect(customEntryFor(CATALOG, `fast`, `claude`)).toBeUndefined();
    expect(customEntryFor(CATALOG, `opus`, `codex`)).toBeUndefined();
});

test("accepts the dotted and date-suffixed id shapes these providers actually ship", () => {
    expect(customEntryFor(CATALOG, `gpt-5.1`, `claude`)?.value).toBe(`gpt-5.1`);
    expect(customEntryFor(CATALOG, `claude-opus-5-20260301`, `claude`)?.value).toBe(`claude-opus-5-20260301`);
});

test("trims surrounding whitespace, so a pasted id still resolves to the bare model", () => {
    expect(customEntryFor(CATALOG, `  claude-opus-6  `, `claude`)?.value).toBe(`claude-opus-6`);
});

test("offers nothing for an empty query, so simply focusing the search box adds no row", () => {
    expect(customEntryFor(CATALOG, `   `, `claude`)).toBeUndefined();
});

// Family-major browsing: a release-timeline catalog would open the picker on five straight Opus versions, burying
// Haiku; a group must open at one row per family.

// Claude's account catalog in its own newest-first order.
const CLAUDE: readonly PickerEntry[] = [
    entry(`claude`, `claude-opus-5`, `Claude Opus 5`),
    entry(`claude`, `claude-sonnet-5`, `Claude Sonnet 5`),
    entry(`claude`, `claude-fable-5`, `Claude Fable 5`),
    entry(`claude`, `claude-opus-4-8`, `Claude Opus 4.8`),
    entry(`claude`, `claude-opus-4-7`, `Claude Opus 4.7`),
    entry(`claude`, `claude-sonnet-4-6`, `Claude Sonnet 4.6`),
    entry(`claude`, `claude-haiku-4-5-20251001`, `Claude Haiku 4.5`),
];

test("groups versions into families by id, so a date suffix or a point release never splits a tier", () => {
    expect(familyGroups(CLAUDE).map((group) => [group.key, group.latest.value, group.older.map((older) => older.value)])).toEqual([
        [`claude-opus`, `claude-opus-5`, [`claude-opus-4-8`, `claude-opus-4-7`]],
        [`claude-fable`, `claude-fable-5`, []],
        [`claude-sonnet`, `claude-sonnet-5`, [`claude-sonnet-4-6`]],
        [`claude-haiku`, `claude-haiku-4-5-20251001`, []],
    ]);
});

test("orders families frontier-first, which the catalog's own order cannot express", () => {
    // Catalog order alone would seat Fable (a frontier model the SDK publishes no alias for) under Sonnet.
    expect(familyGroups(CLAUDE).map((group) => group.label)).toEqual([`Claude Opus`, `Claude Fable`, `Claude Sonnet`, `Claude Haiku`]);
});

test("leads with a family no tier rank names, so a brand-new flagship is never buried by its own novelty", () => {
    // An unrecognized family id ranks above every recognized tier, never below.
    const groups = familyGroups([entry(`claude`, `claude-mythos-1`, `Claude Mythos 1`), ...CLAUDE]);

    expect(groups[0]?.key).toBe(`claude-mythos`);
});

test("breaks a tier tie by release, so the family that shipped last leads the ones that share its rank", () => {
    const groups = familyGroups([entry(`claude`, `claude-fable-6`, `Claude Fable 6`), ...CLAUDE]);

    expect(groups.map((group) => group.key)).toEqual([`claude-fable`, `claude-opus`, `claude-sonnet`, `claude-haiku`]);
});

test("keeps catalog order between families that tie on BOTH, since Anthropic's catalog is itself a ranking", () => {
    // Same tier, same version: nothing derived can separate them, so catalog order stands here.
    const opus = entry(`claude`, `claude-opus-5`, `Claude Opus 5`);
    const fable = entry(`claude`, `claude-fable-5`, `Claude Fable 5`);

    expect(familyGroups([opus, fable]).map((group) => group.key)).toEqual([`claude-opus`, `claude-fable`]);
    expect(familyGroups([fable, opus]).map((group) => group.key)).toEqual([`claude-fable`, `claude-opus`]);
});

// Other providers (Codex, Gemini, Kimi, Grok) arrive from /v1/models in registry order (alphabetical), unlike
// Anthropic's newest-first; ranking and family membership are derived from the id instead.

// Codex exactly as the endpoint hands it over: alphabetical, i.e. meaningless.
const CODEX: readonly PickerEntry[] = [
    entry(`codex`, `gpt-5.1-codex`, `GPT 5.1 Codex`),
    entry(`codex`, `gpt-5.4-mini`, `GPT 5.4 Mini`),
    entry(`codex`, `gpt-5.5`, `GPT 5.5`),
    entry(`codex`, `gpt-5.6-luna`, `GPT 5.6 Luna`),
    entry(`codex`, `gpt-5.6-sol`, `GPT 5.6 Sol`),
    entry(`codex`, `gpt-5.6-terra`, `GPT 5.6 Terra`),
];

test("opens a registry-ordered group with Sol first and the remaining Codex tiers strongest-first", () => {
    expect(pickerBlocks(familyGroups(CODEX), undefined, false)[0]?.entries.map((row) => row.label)).toEqual([
        `GPT 5.6 Sol`,
        `GPT 5.6 Terra`,
        `GPT 5.6 Luna`,
        `GPT 5.5`,
        `GPT 5.1 Codex`,
        `GPT 5.4 Mini`,
    ]);
});

test("shows a family's NEWEST version collapsed, not whichever version the endpoint listed first", () => {
    // Alphabetically gpt-5.1 leads the family; the collapsed row must still show the newest, gpt-5.6.
    const gpt = [entry(`codex`, `gpt-5.1`, `GPT 5.1`), entry(`codex`, `gpt-5.6`, `GPT 5.6`)];

    expect(familyGroups(gpt)[0]).toMatchObject({ latest: gpt[1], older: [gpt[0]] });
});

test("ranks each vendor's own tier words, so no provider is left in registry order", () => {
    const gemini = [
        entry(`gemini`, `gemini-3-flash`, `Gemini 3 Flash`),
        entry(`gemini`, `gemini-3-flash-lite`, `Gemini 3 Flash Lite`),
        entry(`gemini`, `gemini-3-pro`, `Gemini 3 Pro`),
    ];
    const grok = [entry(`grok`, `grok-3`, `Grok 3`), entry(`grok`, `grok-4-fast`, `Grok 4 Fast`), entry(`grok`, `grok-4`, `Grok 4`)];

    expect(familyGroups(gemini).map((group) => group.latest.label)).toEqual([`Gemini 3 Pro`, `Gemini 3 Flash`, `Gemini 3 Flash Lite`]);
    expect(familyGroups(grok).map((group) => group.latest.label)).toEqual([`Grok 4`, `Grok 4 Fast`]);
});

test("opens Kimi on K3 when its live catalog also contains K2.x releases", () => {
    const kimi = [entry(`kimi`, `kimi-k2.6`, `Kimi K2.6`), entry(`kimi`, `kimi-k2.7-code`, `Kimi K2.7 Code`), entry(`kimi`, `kimi-k3`, `Kimi K3`)];

    expect(pickerBlocks(familyGroups(kimi), undefined, false)[0]?.entries.map((row) => row.value)).toEqual([`kimi-k3`, `kimi-k2.7-code`]);
});

test("opens a group at one row per family: every tier visible, no version history", () => {
    expect(pickerBlocks(familyGroups(CLAUDE), `claude-opus-5`, false)).toEqual([
        { key: `latest`, entries: [CLAUDE[0], CLAUDE[2], CLAUDE[1], CLAUDE[6]] },
    ]);
});

test("keeps the selected model visible when it is an older version the latest band drops", () => {
    // Otherwise a user pinned to an older version opens the picker with no checkmark anywhere in it.
    const [band] = pickerBlocks(familyGroups(CLAUDE), `claude-opus-4-7`, false);

    expect(band?.entries.at(-1)?.value).toBe(`claude-opus-4-7`);
});

test("ignores a selected id the group does not publish, rather than padding the band", () => {
    // A custom model rides an id in no catalog; it must not conjure a phantom row into a provider's group.
    expect(pickerBlocks(familyGroups(CLAUDE), `claude-opus-9`, false)[0]?.entries).toHaveLength(4);
});

test("expands into per-family blocks, because the intent is 'Opus, an older one': never 'row 11'", () => {
    expect(pickerBlocks(familyGroups(CLAUDE), undefined, true).map((block) => [block.label, block.entries.map((row) => row.value)])).toEqual([
        [undefined, [`claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`]],
        [`Claude Opus`, [`claude-opus-4-8`, `claude-opus-4-7`]],
        [`Claude Sonnet`, [`claude-sonnet-4-6`]],
    ]);
});

test("gives a single-version provider no older blocks, so a short group never grows a disclosure", () => {
    const codex = [entry(`codex`, `gpt-5.1`, `GPT 5.1`), entry(`codex`, `gpt-5`, `GPT 5`)];

    expect(pickerBlocks(familyGroups(codex), undefined, false)).toEqual([{ key: `latest`, entries: [codex[0]] }]);
});

// Access order: every catalog is non-empty whether connected or not (the daemon serves a seed floor), so readiness must
// be the top-level ordering rule, outranking everything else.

const MIXED: readonly PickerEntry[] = [
    entry(`claude`, `claude-opus-5`, `Claude Opus 5`),
    entry(`codex`, `gpt-5.6`, `GPT 5.6`),
    entry(`kimi`, `kimi-k3`, `Kimi K3`),
    entry(`gemini`, `gemini-pro-agent`, `Gemini 3.1 Pro (High)`),
];
const readyOnly =
    (...connected: AgentProvider[]) =>
    (provider: AgentProvider) =>
        connected.includes(provider);

test("seats connected providers above the ones that still need a credential", () => {
    // PROVIDERS order alone put Kimi (with no Kimi Code subscription) above a connected Gemini purely by position.
    const sections = pickerSections(MIXED, `claude`, undefined, readyOnly(`claude`, `gemini`));

    expect(sections.slice(0, 3).map((section) => section.key)).toEqual([`claude`, `gemini`, `codex`]);
});

test("keeps the ACTIVE provider first even when it is the locked one", () => {
    // It's the provider the composer will send on; burying it would hide the selection the user is already on.
    expect(pickerSections(MIXED, `kimi`, undefined, readyOnly(`claude`))[0]?.key).toBe(`kimi`);
});

// The cheapest way in leads the locked band (free Google ahead of paid subscriptions), not sorted last by PROVIDERS
// order. Cost separates only locked rows; a connected provider stays ranked by readiness alone, never re-sorted by
// price.
test("leads the locked band with the provider that costs nothing", () => {
    const sections = pickerSections(MIXED, `codex`, undefined, readyOnly(`claude`));

    // Active first, then connected, then free ahead of paid; ties keep PROVIDERS order.
    expect(sections.map((section) => section.key)).toEqual([`codex`, `claude`, `gemini`, `grok`, `kimi`, `cursor`, `meta`, `zai`]);
});

test("ranks a runnable match above a locked one, however well the locked id matched", () => {
    // A query can hit multiple rows; match quality still decides ranking within an access band.
    const matched = filterEntries(MIXED, `5`, undefined, readyOnly(`codex`));

    expect(matched.map((row) => row.provider)).toEqual([`codex`, `claude`]);
});

test("leaves an unqueried list in access order too, so simply opening the picker leads with what can run", () => {
    expect(filterEntries(MIXED, ``, undefined, readyOnly(`gemini`)).map((row) => row.provider)).toEqual([`gemini`, `claude`, `codex`, `kimi`]);
});

// The local lane: every locally-run card is folded into one lane, in both the rail (one chip) and the list (one group),
// rather than one identical-looking chip per card.

const LOCAL: readonly PickerEntry[] = [
    entry(`endpoint/ollama-a`, `qwen3-8`, `qwen3-8`),
    entry(`endpoint/ollama-b`, `qwen3-5-64k`, `qwen3-5-64k`),
    entry(`claude`, `claude-opus-5`, `Claude Opus 5`),
];

const withCards = (...cards: { id: string; label: string; kind: "endpoint" | "localmodel" }[]): void => {
    endpointProviders.value = cards;
};

afterEach(() => {
    endpointProviders.value = [];
});

test("folds every locally-run card into one lane, so the rail draws one chip and the list one group", () => {
    withCards({ id: `endpoint/ollama-a`, label: `Ollama A`, kind: `localmodel` }, { id: `endpoint/ollama-b`, label: `Ollama B`, kind: `localmodel` });

    expect(lanesOf([`claude`, `endpoint/ollama-a`, `endpoint/ollama-b`])).toEqual([
        { key: `claude`, label: providerLabel(`claude`), providers: [`claude`] },
        { key: LOCAL_MODELS_GROUP, label: `Local models`, providers: [`endpoint/ollama-a`, `endpoint/ollama-b`] },
    ]);
});

test("leaves a remote endpoint its own lane: a server the user pointed us at is not their machine", () => {
    withCards({ id: `endpoint/ollama-a`, label: `Ollama A`, kind: `localmodel` }, { id: `endpoint/vllm`, label: `vLLM`, kind: `endpoint` });

    expect(lanesOf([`endpoint/ollama-a`, `endpoint/vllm`]).map((lane) => lane.key)).toEqual([LOCAL_MODELS_GROUP, `endpoint/vllm`]);
});

test("draws one section holding every card's models, which is the group the rail chip now opens", () => {
    withCards({ id: `endpoint/ollama-a`, label: `Ollama A`, kind: `localmodel` }, { id: `endpoint/ollama-b`, label: `Ollama B`, kind: `localmodel` });

    const local = pickerSections(LOCAL, `claude`, undefined, readyOnly(`claude`)).find((section) => section.key === LOCAL_MODELS_GROUP);

    expect(local?.total).toBe(2);
    expect(local?.groups.map((group) => group.latest.value)).toEqual([`qwen3-8`, `qwen3-5-64k`]);
});

test("keeps each card's families apart, so one machine's model never hides behind another's disclosure", () => {
    // qwen3-8 and qwen3-32 share a family id; folding must not file one machine under another's version.
    withCards({ id: `endpoint/ollama-a`, label: `Ollama A`, kind: `localmodel` }, { id: `endpoint/ollama-b`, label: `Ollama B`, kind: `localmodel` });
    const twins = [entry(`endpoint/ollama-a`, `qwen3-8`, `qwen3-8`), entry(`endpoint/ollama-b`, `qwen3-32`, `qwen3-32`)];

    const [local] = pickerSections(twins, `endpoint/ollama-a`, undefined, readyOnly());

    expect(pickerBlocks(local!.groups, undefined, false)[0]?.entries.map((row) => row.value)).toEqual([`qwen3-8`, `qwen3-32`]);
});

test("filters to the whole lane, so the one chip scopes the list to every card at once", () => {
    withCards({ id: `endpoint/ollama-a`, label: `Ollama A`, kind: `localmodel` }, { id: `endpoint/ollama-b`, label: `Ollama B`, kind: `localmodel` });

    expect(filterEntries(LOCAL, ``, LOCAL_MODELS_GROUP, readyOnly()).map((row) => row.value)).toEqual([`qwen3-8`, `qwen3-5-64k`]);
});
