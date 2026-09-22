// The `@` token's setting rows, pinned as a table: what an empty token lists, what a word matches, what a drill
// shows, and that a kind the pill row refuses is nowhere.
import type { AgentProvider, Persona } from "@intentic/sandbox-contract";
import { it, expect, mock } from "bun:test";
import type { PickerEntry } from "../models/modelPickerState";
import { DRILLED_ROWS, FLAT_MODEL_ROWS, kindMeta, type QuickPickSources, quickRows } from "./composerQuickPick";
import { QUICK_KINDS } from "./useMentions";

// modelPickerState imports conversation.ts for the live catalogs; stub its side-effects so the import is inert.
mock.module("../../sandbox/client/sandboxClient", () => ({ sandboxRequest: mock() }));
mock.module("../models/useChat-catalog", () => ({ loadProviderModels: mock(async () => {}) }));

const entry = (provider: AgentProvider, value: string, label: string): PickerEntry => ({ key: `${provider}:${value}`, provider, value, label });
const persona = (id: string, extra: Partial<Persona> = {}): Persona => ({ id, capabilities: [], ...extra });

const MODELS: readonly PickerEntry[] = [
    entry(`claude`, `claude-opus-5`, `Claude Opus 5`),
    entry(`claude`, `claude-sonnet-4-5`, `Claude Sonnet 4.5`),
    entry(`codex`, `gpt-5.1`, `GPT 5.1`),
];

// Everything offered, a persona picked, running here on Opus at high effort.
const ALL: QuickPickSources = {
    persona: { personas: [persona(`intentic`, { label: `Intentic`, brief: `Product work` }), persona(`radarsu`)], picked: `intentic` },
    sandbox: { runners: [{ id: `omen` }], boxes: [{ id: `box-2`, name: `Paperwork` }], box: undefined, runner: undefined },
    model: { entries: MODELS, provider: `claude`, model: `claude-opus-5`, isReady: () => true },
    effort: {
        options: [
            { label: `Low`, value: `low` },
            { label: `High`, value: `high` },
            { label: `Max`, value: `max` },
        ],
        picked: `high`,
    },
};

const labels = (sources: QuickPickSources, token: Parameters<typeof quickRows>[1]): string[] => quickRows(sources, token).map((row) => row.label);

it(`lists one summary row per offered kind, in kind order, each carrying the current value`, () => {
    const rows = quickRows(ALL, { kind: undefined, query: `` });
    expect(rows.map((row) => row.kind)).toEqual([`drill`, `drill`, `drill`, `drill`]);
    expect(rows.map((row) => (row.kind === `drill` ? row.into : undefined))).toEqual([...QUICK_KINDS]);
    expect(rows.map((row) => row.label)).toEqual(QUICK_KINDS.map((kind) => kindMeta()[kind].label));
    expect(rows.map((row) => row.detail)).toEqual([`Intentic`, `Here`, `Claude Opus 5`, `High`]);
});

it(`names a raw id when the current pick is on no list, never an empty value`, () => {
    const gone: QuickPickSources = {
        ...ALL,
        persona: { personas: [], picked: `deleted` },
        sandbox: { runners: [], boxes: [], box: `unknown-box`, runner: undefined },
        model: { entries: [], provider: `claude`, model: `claude-opus-9`, isReady: () => true },
    };
    expect(quickRows(gone, { kind: undefined, query: `` }).map((row) => row.detail)).toEqual([`deleted`, `Another sandbox`, `claude-opus-9`, `High`]);
    expect(
        quickRows({ ...ALL, sandbox: { runners: [], boxes: [], box: undefined, runner: `omen` } }, { kind: undefined, query: `` })[1]?.detail,
    ).toBe(`omen`);
});

it(`offers a kind in neither the summary nor a search once its source is withheld`, () => {
    const noPersona: QuickPickSources = { ...ALL, persona: undefined };
    expect(quickRows(noPersona, { kind: undefined, query: `` }).map((row) => (row.kind === `drill` ? row.into : row.kind))).toEqual([
        `sandbox`,
        `model`,
        `effort`,
    ]);
    expect(quickRows(noPersona, { kind: undefined, query: `int` })).toEqual([]);
    expect(quickRows(noPersona, { kind: `persona`, query: `` })).toEqual([]);
    expect(quickRows({ persona: undefined, sandbox: undefined, model: undefined, effort: undefined }, { kind: undefined, query: `` })).toEqual([]);
});

it(`matches a typed word against every kind at once, kinds in order, with the current row ticked`, () => {
    // "hi" is in "Where this runs", "This sandbox" and "High"; in no persona and no model.
    const rows = quickRows(ALL, { kind: undefined, query: `hi` });
    expect(rows.map((row) => `${row.kind}:${row.label}`)).toEqual([`drill:Where this runs`, `sandbox:This sandbox`, `effort:High`]);
    expect(rows.map((row) => (row.kind === `drill` ? undefined : row.current))).toEqual([undefined, true, true]);
});

it(`matches names and ids the way the model list does (separators ignored), never a detail line`, () => {
    expect(labels(ALL, { kind: undefined, query: `radar` })).toEqual([`radarsu`]);
    expect(labels(ALL, { kind: undefined, query: `sonnet45` })).toEqual([`Claude Sonnet 4.5`]);
    // The persona's brief says "Product work"; the runner row's detail says "Runner on your computer".
    expect(labels(ALL, { kind: undefined, query: `product` })).toEqual([]);
    expect(labels(ALL, { kind: undefined, query: `computer` })).toEqual([]);
});

it(`puts the kind's summary row first when the word names the kind, so Enter drills in`, () => {
    const rows = quickRows(ALL, { kind: undefined, query: `sand` });
    expect(rows[0]).toMatchObject({ kind: `drill`, into: `sandbox`, label: `Where this runs`, detail: `Here` });
    // "sand" is also in "This sandbox".
    expect(rows.slice(1).map((row) => row.label)).toEqual([`This sandbox`]);
    expect(quickRows(ALL, { kind: undefined, query: `acts` })[0]).toMatchObject({ kind: `drill`, into: `persona` });
    expect(quickRows(ALL, { kind: undefined, query: `where` })[0]).toMatchObject({ kind: `drill`, into: `sandbox` });
});

it(`caps models in a flat search at the boundary, so files below stay within reach`, () => {
    const many = Array.from({ length: FLAT_MODEL_ROWS + 1 }, (_, index) => entry(`claude`, `claude-m-${index}`, `Claude M${index}`));
    const sources: QuickPickSources = { ...ALL, model: { entries: many, provider: `claude`, model: `claude-m-0`, isReady: () => true } };
    expect(quickRows(sources, { kind: undefined, query: `claude` }).filter((row) => row.kind === `model`)).toHaveLength(FLAT_MODEL_ROWS);
    expect(quickRows(sources, { kind: `model`, query: `claude` })).toHaveLength(FLAT_MODEL_ROWS + 1);
});

it(`drills into one kind alone, caps its list at the boundary, and leads with the current pick`, () => {
    const many = Array.from({ length: DRILLED_ROWS + 1 }, (_, index) => entry(`claude`, `claude-m-${index}`, `Claude M${index}`));
    const sources: QuickPickSources = { ...ALL, model: { entries: many, provider: `claude`, model: `claude-m-7`, isReady: () => true } };
    const rows = quickRows(sources, { kind: `model`, query: `` });
    expect(rows).toHaveLength(DRILLED_ROWS);
    expect(rows.every((row) => row.kind === `model`)).toBe(true);
    expect(rows[0]).toMatchObject({ label: `Claude M7`, current: true });
    expect(rows[1]).toMatchObject({ label: `Claude M0`, current: false });
    // A typed word keeps the list's own ranking: the current pick earns no lead over a better match.
    expect(labels(sources, { kind: `model`, query: `m1` })).toEqual([`Claude M1`, `Claude M10`, `Claude M11`, `Claude M12`]);
});

it(`drills the other three kinds to their whole lists, Anyone and This sandbox first`, () => {
    expect(labels(ALL, { kind: `persona`, query: `` })).toEqual([`Anyone`, `Intentic`, `radarsu`]);
    expect(labels(ALL, { kind: `sandbox`, query: `` })).toEqual([`This sandbox`, `omen`, `Paperwork`]);
    expect(labels(ALL, { kind: `effort`, query: `` })).toEqual([`Low`, `High`, `Max`]);
    expect(labels(ALL, { kind: `effort`, query: `ma` })).toEqual([`Max`]);
});

it(`carries what a pick needs: the persona id, both placement axes, the model entry, the effort value`, () => {
    expect(quickRows(ALL, { kind: `persona`, query: `` })).toMatchObject([{ id: undefined }, { id: `intentic` }, { id: `radarsu` }]);
    expect(quickRows(ALL, { kind: `sandbox`, query: `` })).toMatchObject([
        { box: undefined, runner: undefined, current: true },
        { box: undefined, runner: `omen`, current: false },
        { box: `box-2`, runner: undefined, current: false },
    ]);
    expect(quickRows(ALL, { kind: `model`, query: `gpt` })).toMatchObject([{ entry: MODELS[2], detail: `Codex`, current: false }]);
    expect(quickRows(ALL, { kind: `effort`, query: `high` })).toMatchObject([{ value: `high`, current: true }]);
});

it(`marks the placed box or runner current, not This sandbox`, () => {
    const placed: QuickPickSources = { ...ALL, sandbox: { ...ALL.sandbox!, box: `box-2` } };
    expect(quickRows(placed, { kind: `sandbox`, query: `` }).map((row) => row.kind === `sandbox` && row.current)).toEqual([false, false, true]);
});
