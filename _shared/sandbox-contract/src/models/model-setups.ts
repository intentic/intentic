import { z } from "zod";
import { type ModelPin, ModelPinSchema } from "../schemas/agent.js";
import { isEndpointProvider } from "./agent-catalog.js";
import { compareModelIds, modelRungOf } from "./model-order.js";
import type { ModelSource } from "./model-pins.js";
import { MODEL_ROLE_IDS, MODEL_ROLES, type ModelRole, PRESET_SETUPS, type PresetSetup } from "./model-roles.js";

// A setup is a named, ordered list of models that any number of jobs run on: edited once, used by every job put there.
// Every sandbox has three, Low, Medium and High, worked out from the accounts it has connected until the owner edits
// one; the owner adds any others. A job runs on nothing until someone puts it on a setup: nothing spends an account, and
// no judge starts holding commands, because an account was connected. Each job's catalog row suggests a preset
// (model-roles.ts `setup`) for when it is placed. Every reader resolves a job through here, daemon and browser alike, so
// the settings page shows what will run.

export const MODEL_SETUP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const ModelSetupSchema = z.object({
    id: z.string().regex(MODEL_SETUP_ID).describe("Which setup this is. `low`, `medium` and `high` are the three every sandbox has; any other is one you made."),
    name: z.string().trim().min(1).max(40).optional().describe("What it is called on the settings page. Left out, a preset keeps its own name."),
    pins: z
        .array(ModelPinSchema)
        .max(10)
        .optional()
        .describe(
            "The models it runs on, tried in order, so one spent account does not take its jobs down. Left out on a preset, it is worked out from the accounts this sandbox has connected and follows them as they change; left out on one you made, it has none.",
        ),
});
export type ModelSetup = z.infer<typeof ModelSetupSchema>;

export const isPresetSetup = (id: string): id is PresetSetup => PRESET_SETUPS.some((preset) => preset === id);

// The settings a job's models are read from; a slice, so a caller holding only these two can resolve.
export interface SetupSettings {
    readonly modelSetups: readonly ModelSetup[];
    readonly roleSetups: Partial<Record<ModelRole, string>>;
}

const SUGGESTED = new Map<ModelRole, PresetSetup>(MODEL_ROLES.map((role) => [role.id, role.setup]));

/** The preset suggested for a job when it is placed. */
export const suggestedSetup = (role: ModelRole): PresetSetup => SUGGESTED.get(role) ?? `medium`;

// First entry wins: a hand-edited file holding one id twice means the earlier, as everywhere else a list is read.
export const storedSetup = (settings: Pick<SetupSettings, "modelSetups">, id: string): ModelSetup | undefined =>
    settings.modelSetups.find((setup) => setup.id === id);

/** The setup a job runs on, or undefined while it is on none (never placed, or placed on a setup that is gone). */
export const roleSetupId = (settings: SetupSettings, role: ModelRole): string | undefined => {
    const assigned = settings.roleSetups[role];
    return assigned !== undefined && (isPresetSetup(assigned) || storedSetup(settings, assigned) !== undefined) ? assigned : undefined;
};

// What a setup runs on before anything is connected or resolved: a written list, or a preset still to be worked out.
// A snapshot of this is what a turn carries, so it is judged by one setup however its accounts change mid-turn.
export type SetupLadder = { readonly kind: `pins`; readonly pins: readonly ModelPin[] } | { readonly kind: `preset`; readonly preset: PresetSetup };

const NO_MODELS: SetupLadder = { kind: `pins`, pins: [] };

export const setupLadder = (settings: Pick<SetupSettings, "modelSetups">, id: string | undefined): SetupLadder => {
    if (id === undefined) {
        return NO_MODELS;
    }
    const pins = storedSetup(settings, id)?.pins;
    if (pins !== undefined) {
        return { kind: `pins`, pins };
    }
    return isPresetSetup(id) ? { kind: `preset`, preset: id } : NO_MODELS;
};

export const roleLadder = (settings: SetupSettings, role: ModelRole): SetupLadder => setupLadder(settings, roleSetupId(settings, role));

/** True only for a ladder that can never name a model, whatever is connected: a written list left empty. */
export const ladderIsEmpty = (ladder: SetupLadder): boolean => ladder.kind === `pins` && ladder.pins.length === 0;

const PRESET_RUNG = { high: 0, medium: 1, low: 2 } as const satisfies Record<PresetSetup, number>;

// Enough to step over one spent account and then another; a preset longer than this would mostly be read, not tried.
const PRESET_LENGTH = 3;

// The first segment most of a catalog's ids share (`gemini`, `gpt`, `claude`): the provider's own family, as opposed to
// a model it also serves from someone else, which Google's catalog does with Claude's.
const ownPrefix = (models: readonly string[]): string | undefined => {
    const counts = new Map<string, number>();
    for (const model of models) {
        const prefix = model.split(/[-_]/)[0] ?? model;
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return [...counts].toSorted(([, a], [, b]) => b - a)[0]?.[0];
};

// A provider's pick for a rung: its own newest there, or a borrowed one only when it has none of its own.
const newestOnRung = (models: readonly string[], rung: number): string | undefined => {
    const own = ownPrefix(models);
    const onRung = models.filter((model) => modelRungOf(model) === rung).toSorted(compareModelIds);
    return onRung.find((model) => model.split(/[-_]/)[0] === own) ?? onRung[0];
};

/**
 * A preset's models, from what is connected: each connected provider's newest model of its own on the preset's rung, in
 * the order the sources come in, at most three. `models` must hold only models that can run a turn, since a preset feeds whole
 * sessions as well as one-shot jobs. Local endpoints are left out: what someone installed for themselves is theirs to
 * put on a setup, not a suggestion.
 */
export const presetPins = (preset: PresetSetup, sources: readonly ModelSource[]): readonly ModelPin[] =>
    sources
        .filter((source) => source.ready && !isEndpointProvider(source.provider))
        .flatMap((source) => {
            const newest = newestOnRung(source.models, PRESET_RUNG[preset]);
            return newest === undefined ? [] : [{ provider: source.provider, model: newest }];
        })
        .slice(0, PRESET_LENGTH);

export const ladderPins = (ladder: SetupLadder, sources: readonly ModelSource[]): readonly ModelPin[] =>
    ladder.kind === `pins` ? ladder.pins : presetPins(ladder.preset, sources);

/** The models a job runs on, in try order, before readiness filters them (model-pins.ts `readyChain`). */
export const rolePins = (settings: SetupSettings, role: ModelRole, sources: readonly ModelSource[]): readonly ModelPin[] =>
    ladderPins(roleLadder(settings, role), sources);

/**
 * Setups for a set of per-job lists, the shape settings had before setups (2026-10-12): jobs holding the same list share
 * one setup, a list most of whose jobs are suggested one preset becomes that preset while it is free, and the rest are
 * new setups. A job with no list, or an empty one, ran on nothing and is left on none. Exported for the settings
 * history and for tests that want a job on exact models.
 */
export const setupsFromRoleLists = (lists: Partial<Record<ModelRole, readonly ModelPin[]>>): SetupSettings & { modelSetups: ModelSetup[] } => {
    const modelSetups: ModelSetup[] = [];
    const roleSetups: Partial<Record<ModelRole, string>> = {};
    const groups = new Map<string, ModelRole[]>();
    for (const role of MODEL_ROLE_IDS) {
        const list = lists[role];
        if (list !== undefined && list.length > 0) {
            const key = JSON.stringify(list);
            groups.set(key, [...(groups.get(key) ?? []), role]);
        }
    }
    let made = 0;
    for (const roles of groups.values()) {
        const pins = lists[roles[0]!] ?? [];
        // The preset most of these jobs are suggested; a tie goes to the first job's, the table's own order.
        const votes = roles.map(suggestedSetup);
        const preset = votes.toSorted((a, b) => votes.filter((vote) => vote === b).length - votes.filter((vote) => vote === a).length)[0]!;
        const free = storedSetup({ modelSetups }, preset) === undefined;
        const id = free ? preset : `setup-${++made}`;
        modelSetups.push(free ? { id, pins: [...pins] } : { id, name: `Setup ${made}`, pins: [...pins] });
        for (const role of roles) {
            roleSetups[role] = id;
        }
    }
    return { modelSetups, roleSetups };
};
