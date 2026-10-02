// The `@` token's setting rows, pinned as a table: what an empty token lists, what a word matches, what a drill
// shows, and that a kind the pill row refuses is nowhere.
import type { AgentProvider, Persona } from "@intentic/sandbox-contract";
import type { PickerEntry } from "../models/modelPickerState";
import { DRILLED_ROWS, FLAT_MODEL_ROWS, kindMeta, type QuickPickSources, quickRows } from "./composerQuickPick";
import { QUICK_KINDS } from "./useMentions";

// modelPickerState imports conversation.ts for the live catalogs; stub its side-effects so the import is inert.
jest.mock("../../sandbox/client/sandboxClient", () => ({ sandboxRequest: jest.fn() }));
jest.mock("../models/useChat-catalog", () => ({ loadProviderModels: jest.fn(async () => {}) }));

const entry = (provider: AgentProvider, value: string, label: string): PickerEntry => ({ key: `${provider}:${value}`, provider, value, label });
const persona = (id: string, extra: Partial<Persona> = {}): Persona => ({ id, capabilities: [], ...extra });

const MODELS: readonly PickerEntry[] = [
    entry(`claude`, `claude-opus-5`, `Claude Opus 5`),
    entry(`claude`, `claude-sonnet-4-5`, `Claude Sonnet 4.5`),
    entry(`codex`, `gpt-5.1`, `GPT 5.1`),
];

// A fixed noon on the reader's own clock, so the quick times are the same however the suite is run.
const NOON = new Date(2026, 9, 2, 12, 0).getTime();
const HOUR = 60 * 60 * 1_000;
const TOMORROW_NINE = new Date(2026, 9, 3, 9, 0).getTime();

// Everything offered, a persona picked, running here on Opus at high effort, sent now and held on its branch.
const ALL: QuickPickSources = {
    persona: { personas: [persona(`intentic`, { label: `Intentic`, brief: `Product work` }), persona(`radarsu`)], picked: `intentic` },
    sandbox: { runners: [{ id: `omen` }], boxes: [{ id: `box-2`, name: `Paperwork` }], box: undefined, runner: undefined },
    model: { entries: MODELS, provider: `claude`, model: `claude-opus-5`, label: `Claude Opus 5`, isReady: () => true },
    effort: {
        options: [
            { label: `Low`, value: `low` },
            { label: `High`, value: `high` },
            { label: `Max`, value: `max` },
        ],
        picked: `high`,
    },
    send: {
        picked: undefined,
        now: NOON,
        choices: [
            { key: `hour`, label: `In an hour`, at: NOON + HOUR },
            { key: `morning`, label: `Tomorrow morning`, at: TOMORROW_NINE },
        ],
        targets: [{ id: `brave-otter`, title: `Fix the login bug` }],
    },
    land: { lands: false },
};

const labels = (sources: QuickPickSources, token: Parameters<typeof quickRows>[1]): string[] => quickRows(sources, token).map((row) => row.label);

it(`lists one summary row per offered kind, in kind order, each carrying the current value`, () => {
    const rows = quickRows(ALL, { kind: undefined, query: `` });
    expect(rows.map((row) => row.kind)).toEqual([`drill`, `drill`, `drill`, `drill`, `drill`, `drill`]);
    expect(rows.map((row) => (row.kind === `drill` ? row.into : undefined))).toEqual([...QUICK_KINDS]);
    expect(rows.map((row) => row.label)).toEqual(QUICK_KINDS.map((kind) => kindMeta()[kind].label));
    expect(rows.map((row) => row.detail)).toEqual([`Intentic`, `Here`, `Claude Opus 5`, `High`, `Now`, `Holds on branch`]);
});

it(`names a pick on no list by its raw id or the model's own name, never an empty value`, () => {
    const gone: QuickPickSources = {
        ...ALL,
        persona: { personas: [], picked: `deleted` },
        sandbox: { runners: [], boxes: [], box: `unknown-box`, runner: undefined },
        model: { entries: [], provider: `claude`, model: `claude-opus-9`, label: `Claude Opus 9`, isReady: () => true },
    };
    expect(quickRows(gone, { kind: undefined, query: `` }).map((row) => row.detail)).toEqual([
        `deleted`,
        `Another sandbox`,
        `Claude Opus 9`,
        `High`,
        `Now`,
        `Holds on branch`,
    ]);
    // A booked agent no card names any more is still named, as another agent.
    const lost: QuickPickSources = { ...ALL, send: { ...ALL.send!, picked: { kind: `after`, conversationId: `gone-fox` } } };
    expect(quickRows(lost, { kind: undefined, query: `send` })[0]).toMatchObject({ kind: `drill`, into: `send`, detail: `another agent` });
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
        `send`,
        `land`,
    ]);
    // Where nothing can be booked or landing is not the reader's, those two are nowhere either.
    const neither: QuickPickSources = { ...ALL, send: undefined, land: undefined };
    expect(quickRows(neither, { kind: undefined, query: `` }).map((row) => (row.kind === `drill` ? row.into : row.kind))).toEqual([
        `persona`,
        `sandbox`,
        `model`,
        `effort`,
    ]);
    expect(quickRows(neither, { kind: `send`, query: `` })).toEqual([]);
    expect(quickRows(neither, { kind: undefined, query: `login` })).toEqual([]);
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
    const sources: QuickPickSources = {
        ...ALL,
        model: { entries: many, provider: `claude`, model: `claude-m-0`, label: `Claude M 0`, isReady: () => true },
    };
    expect(quickRows(sources, { kind: undefined, query: `claude` }).filter((row) => row.kind === `model`)).toHaveLength(FLAT_MODEL_ROWS);
    expect(quickRows(sources, { kind: `model`, query: `claude` })).toHaveLength(FLAT_MODEL_ROWS + 1);
});

it(`drills into one kind alone, caps its list at the boundary, and leads with the current pick`, () => {
    const many = Array.from({ length: DRILLED_ROWS + 1 }, (_, index) => entry(`claude`, `claude-m-${index}`, `Claude M${index}`));
    const sources: QuickPickSources = {
        ...ALL,
        model: { entries: many, provider: `claude`, model: `claude-m-7`, label: `Claude M 7`, isReady: () => true },
    };
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

// When the message goes is one more setting at the `@`: now, a quick time, a time of the reader's own (which opens the
// panel, since no token holds a date), or after another agent's work lands.
it(`drills the send kind to now, the quick times, a time of one's own, then the agents to wait for`, () => {
    const rows = quickRows(ALL, { kind: `send`, query: `` });
    expect(rows.map((row) => row.label)).toEqual([`Now`, `In an hour`, `Tomorrow morning`, `Pick a date and time…`, `Fix the login bug`]);
    expect(rows.map((row) => (row.kind === `send` ? row.to : undefined))).toEqual([
        `now`,
        { kind: `at`, at: NOON + HOUR },
        { kind: `at`, at: TOMORROW_NINE },
        `custom`,
        { kind: `after`, conversationId: `brave-otter` },
    ]);
    expect(rows.map((row) => (row.kind === `send` ? row.current : undefined))).toEqual([true, false, false, false, false]);
    expect(rows[4]).toMatchObject({ detail: `After it lands` });
});

it(`ticks the booked time or agent, and finds an agent to wait for by a word typed at the @`, () => {
    const booked: QuickPickSources = { ...ALL, send: { ...ALL.send!, picked: { kind: `after`, conversationId: `brave-otter` } } };
    expect(quickRows(booked, { kind: `send`, query: `` }).map((row) => (row.kind === `send` ? row.current : undefined))).toEqual([
        false,
        false,
        false,
        false,
        true,
    ]);
    expect(quickRows(booked, { kind: undefined, query: `send` })[0]).toMatchObject({ kind: `drill`, into: `send`, detail: `Fix the login bug` });
    const rows = quickRows(ALL, { kind: undefined, query: `login` });
    expect(rows.map((row) => `${row.kind}:${row.label}`)).toEqual([`send:Fix the login bug`]);
});

it(`drills landing to its two answers, the one in force ticked`, () => {
    expect(quickRows(ALL, { kind: `land`, query: `` })).toMatchObject([
        { kind: `land`, on: true, label: `Lands by itself`, current: false },
        { kind: `land`, on: false, label: `Holds on branch`, current: true },
    ]);
    const landing: QuickPickSources = { ...ALL, land: { lands: true } };
    expect(quickRows(landing, { kind: undefined, query: `land` })[0]).toMatchObject({ kind: `drill`, into: `land`, detail: `Lands by itself` });
});
