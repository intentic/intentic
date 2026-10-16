import {
    isPresetSetup,
    type ModelSetup,
    presetPins,
    roleSetupId,
    type SetupSettings,
    storedSetup,
    suggestedSetup,
} from "@intentic/sandbox-contract/models/model-setups";
import { MODEL_ROLE_IDS, type ModelRole, PRESET_SETUPS, type PresetSetup } from "@intentic/sandbox-contract/models/model-roles";
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { ModelSource } from "@intentic/sandbox-contract/models/model-pins";

// The Models page as data: every setup in the order the page draws it, the jobs on each, and the writes each press makes.
// Nothing here is held between visits; it is all read off the two settings (modelSetups, roleSetups) through the
// contract's own resolver, so the page draws what the daemon will run.

export interface SetupView {
    readonly id: string;
    /** Set on the three every sandbox has. */
    readonly preset: PresetSetup | undefined;
    /** As stored; the page names a preset with none, and a setup of the owner's always has one. */
    readonly name: string | undefined;
    /** A preset still worked out from what is connected, rather than a list someone wrote. */
    readonly derived: boolean;
    readonly pins: readonly ModelPin[];
    /** In the catalog's order. */
    readonly roles: readonly ModelRole[];
}

export interface SetupsView {
    readonly setups: readonly SetupView[];
    /** The jobs on no setup, which run on nothing: the list a job is dragged from. */
    readonly unassigned: readonly ModelRole[];
}

/** The page's whole picture: the presets, cheapest first, then the owner's own in the order they were made. */
export function setupsView(settings: SetupSettings, sources: readonly ModelSource[]): SetupsView {
    const placed = new Map(MODEL_ROLE_IDS.map((role) => [role, roleSetupId(settings, role)]));
    const rolesOn = (id: string): ModelRole[] => MODEL_ROLE_IDS.filter((role) => placed.get(role) === id);
    const presets = PRESET_SETUPS.map<SetupView>((preset) => {
        const stored = storedSetup(settings, preset);
        return {
            id: preset,
            preset,
            name: stored?.name,
            derived: stored?.pins === undefined,
            pins: stored?.pins ?? presetPins(preset, sources),
            roles: rolesOn(preset),
        };
    });
    const seen = new Set<string>();
    const own = settings.modelSetups.flatMap<SetupView>((setup) => {
        if (isPresetSetup(setup.id) || seen.has(setup.id)) {
            return [];
        }
        seen.add(setup.id);
        return [{ id: setup.id, preset: undefined, name: setup.name, derived: false, pins: setup.pins ?? [], roles: rolesOn(setup.id) }];
    });
    return { setups: [...presets, ...own], unassigned: MODEL_ROLE_IDS.filter((role) => placed.get(role) === undefined) };
}

/** A settings write: whole values, since the settings route merges only at the top level. */
export interface SetupsWrite {
    modelSetups?: ModelSetup[];
    roleSetups?: SetupSettings["roleSetups"];
}

/** A setup made by a press, and the write that makes it. */
export interface NewSetup {
    readonly id: string;
    readonly write: SetupsWrite;
}

interface FreeId {
    readonly id: string;
    readonly n: number;
}

const replaced = (settings: SetupSettings, id: string, change: (setup: ModelSetup) => ModelSetup | undefined): ModelSetup[] => {
    const exists = storedSetup(settings, id) !== undefined;
    const next = exists ? settings.modelSetups.map((setup) => (setup.id === id ? change(setup) : setup)) : [...settings.modelSetups, change({ id })];
    return next.filter((setup): setup is ModelSetup => setup !== undefined);
};

/** A setup's models, edited: written whole. Editing a worked-out preset makes it a written one from then on. */
export const withSetupPins = (settings: SetupSettings, id: string, pins: readonly ModelPin[]): SetupsWrite => ({
    modelSetups: replaced(settings, id, (setup) => ({ ...setup, pins: [...pins] })),
});

/** A setup renamed. A preset given back an empty name takes its own again; one of the owner's keeps the name it had. */
export const withSetupName = (settings: SetupSettings, id: string, name: string): SetupsWrite | undefined => {
    const trimmed = name.trim().slice(0, 40);
    if (trimmed === `` && !isPresetSetup(id)) {
        return undefined;
    }
    return {
        modelSetups: replaced(settings, id, ({ name: _name, ...setup }): ModelSetup | undefined => {
            if (trimmed !== ``) {
                return { ...setup, name: trimmed };
            }
            // A preset with neither a name nor models of its own is the preset as shipped: no entry at all.
            return isPresetSetup(id) && setup.pins === undefined ? undefined : setup;
        }),
    };
};

/** A preset back on what is connected: its written models dropped, its name kept. */
export const withSuggestedModels = (settings: SetupSettings, id: PresetSetup): SetupsWrite => ({
    modelSetups: replaced(settings, id, ({ pins: _pins, ...setup }) => (setup.name === undefined ? undefined : setup)),
});

// The lowest free `setup-N`, so ids stay short and a deleted one's number is reused.
const freeId = (settings: SetupSettings): FreeId => {
    for (let n = 1; ; n += 1) {
        if (storedSetup(settings, `setup-${n}`) === undefined) {
            return { id: `setup-${n}`, n };
        }
    }
};

/** A new setup of the owner's, named by the caller (who knows the words), holding a copy of the models given. */
export const withNewSetup = (settings: SetupSettings, name: (n: number) => string, pins: readonly ModelPin[]): NewSetup => {
    const { id, n } = freeId(settings);
    return { id, write: { modelSetups: [...settings.modelSetups, { id, name: name(n), pins: [...pins] }] } };
};

const placing = (settings: SetupSettings, roles: readonly ModelRole[], target: (role: ModelRole) => string | undefined): SetupSettings["roleSetups"] => {
    const next = { ...settings.roleSetups };
    for (const role of roles) {
        const id = target(role);
        if (id === undefined) {
            delete next[role];
        } else {
            next[role] = id;
        }
    }
    return next;
};

/** A job put on another setup, or (undefined) taken off every setup, back to running on nothing. */
export const withJobOn = (settings: SetupSettings, role: ModelRole, target: string | undefined): SetupsWrite => ({
    roleSetups: placing(settings, [role], () => target),
});

/** Each of these jobs put on the preset suggested for it: the one press that sets a fresh sandbox going. */
export const withSuggestedPlaces = (settings: SetupSettings, roles: readonly ModelRole[]): SetupsWrite => ({
    roleSetups: placing(settings, roles, suggestedSetup),
});

/** A job given a setup of its own, starting as a copy of what it runs on now so nothing changes until it is edited. */
export const withJobOnNewSetup = (settings: SetupSettings, role: ModelRole, name: (n: number) => string, pins: readonly ModelPin[]): SetupsWrite => {
    const { id, write } = withNewSetup(settings, name, pins);
    return { ...write, roleSetups: placing(settings, [role], () => id) };
};

/** A setup of the owner's deleted: its jobs are on none again, and listed as such, rather than moved where nobody chose. */
export const withoutSetup = (settings: SetupSettings, id: string): SetupsWrite => ({
    modelSetups: settings.modelSetups.filter((setup) => setup.id !== id),
    roleSetups: Object.fromEntries(Object.entries(settings.roleSetups).filter(([, target]) => target !== id)),
});
