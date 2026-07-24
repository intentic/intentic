import type { AgentProvider } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { COLLAPSED_ROWS, collapseEntries, customEntryFor, type PickerEntry } from "./modelPicker";

/* The custom-model escape hatch. Everything else in modelPicker.ts is pure derivation over the live catalogs;
 * this is the one path that lets a user name a model NO catalog published, which is the only way to reach a
 * model during the window between it shipping and the catalogs adopting it. */

// modelPicker pulls in conversation.ts for the live catalogs; stub its side-effecting seams so the import is inert.
vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn() }));
vi.mock("./useChat", () => ({ loadProviderModels: vi.fn(async () => {}) }));

const entry = (provider: AgentProvider, value: string, label: string): PickerEntry => ({ key: `${provider}:${value}`, provider, value, label });

const CATALOG: readonly PickerEntry[] = [
    entry(`claude`, `opus`, `Opus`),
    entry(`claude`, `claude-opus-5`, `Claude Opus 5`),
    entry(`codex`, `gpt-5.1`, `GPT 5.1`),
];

test("offers a typed id no catalog row covers, so a model that already serves turns is reachable", () => {
    // The gap this fills: Claude Code's tier aliases lag a release by design and a REST /v1/models entry has to
    // roll out to the account, yet the CLI itself accepts an arbitrary model string — so the picker must too.
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

test("still offers an id only ANOTHER provider publishes — model ids are provider-scoped", () => {
    expect(customEntryFor(CATALOG, `gpt-5.1`, `claude`)?.provider).toBe(`claude`);
});

test("treats a multi-word query as a search, never an id", () => {
    expect(customEntryFor(CATALOG, `claude opus`, `claude`)).toBeUndefined();
});

test("stays silent for a bare search word, so browsing never grows a junk row per keystroke", () => {
    // Typing "fast" to find "Grok 4 Fast" must not also offer a model literally named `fast`. Every real id
    // across these providers is hyphenated, and the un-hyphenated tier aliases are catalog rows already.
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

/* Browse-mode collapse. Merging the REST catalog took Claude's group past a screenful, which is what pushed
 * every other provider below the fold — the group has to open short and expand in place. */

const LONG = Array.from({ length: 15 }, (_, position) => entry(`claude`, `model-${position}`, `Model ${position}`));

test("keeps a short group whole, so a two-model provider never grows a disclosure", () => {
    const short = LONG.slice(0, COLLAPSED_ROWS);
    expect(collapseEntries(short, undefined)).toEqual(short);
});

test("collapses a long group to the head of the PROVIDER'S order, which is already newest-first", () => {
    // Not a date sort of our own: the head is whatever order the catalog arrived in (aliases, then /v1/models
    // newest-first), so "newest" costs no metadata and breaks no ranking rule.
    expect(collapseEntries(LONG, undefined)).toEqual(LONG.slice(0, COLLAPSED_ROWS));
});

test("keeps the selected model visible even when truncation would drop it", () => {
    // The reason this isn't a bare slice: a user pinned to an older version would otherwise open the picker to a
    // list with no checkmark anywhere in it, and no sign of which model the next turn actually runs.
    const collapsed = collapseEntries(LONG, `model-14`);

    expect(collapsed).toHaveLength(COLLAPSED_ROWS + 1);
    expect(collapsed.at(-1)?.value).toBe(`model-14`);
});

test("does not duplicate a selected model that already survived the cut", () => {
    expect(collapseEntries(LONG, `model-2`)).toEqual(LONG.slice(0, COLLAPSED_ROWS));
});

test("ignores a selected id the group does not publish, rather than padding the list", () => {
    // A custom model rides an id in no catalog; it must not conjure a phantom row into another provider's group.
    expect(collapseEntries(LONG, `claude-opus-9`)).toEqual(LONG.slice(0, COLLAPSED_ROWS));
});
