import type { DeviceSandboxResources } from "./deviceDetail.js";

// Arithmetic behind SandboxResourcesDialog.vue: what the form holds, where it starts, what the machine
// accepts, and what leaves on Apply. Structural rather than the sandbox contract's own types, since
// `@intentic/ui` carries no domain dependency.

// The two directive tokens the switches stand for, in the run contract's own single-token spelling; used
// only to read a container's lists, never to validate one.
export const PRIVILEGED_TOKEN = `--privileged`;
export const GPU_TOKEN = `--gpus=all`;

/** The Docker engine's size: all a sandbox can use, whatever its caps say. */
export interface EngineFacts {
    memoryBytes: number;
    cpus: number;
}

// Mirrored from the run contract's `localSandboxMemory`/`localSandboxCpus`, which bounds whatever arrives the same way.
const GIB = 1024 ** 3;
const MEMORY_FLOOR_GIB = 4;
const HOST_RESERVE_GIB = 3;

export interface CapBounds {
    readonly min: number;
    readonly max?: number | undefined;
}

// A floor and no ceiling: the owner may give the sandbox the engine's reserve, or a cap past the engine's size.
export const MEMORY_BOUNDS: CapBounds = { min: MEMORY_FLOOR_GIB };

// The engine's memory in whole GiB, rounded down: a cap above it buys the sandbox nothing.
export const engineMemoryGib = (engine: EngineFacts | undefined): number | undefined =>
    engine === undefined ? undefined : Math.floor(engine.memoryBytes / GIB);

// What an empty memory field means on this engine: the contract's derived cap, the engine minus its reserve.
export const defaultMemoryGib = (engine: EngineFacts | undefined): number | undefined => {
    const total = engineMemoryGib(engine);
    return total === undefined ? undefined : Math.max(MEMORY_FLOOR_GIB, total - HOST_RESERVE_GIB);
};

export const cpuBounds = (engine: EngineFacts | undefined): CapBounds =>
    engine === undefined ? { min: 1 } : { min: 1, max: Math.max(1, Math.floor(engine.cpus)) };

// What the form holds. `null` is the default, shown as an empty field. The switches hold the ASK rather
// than docker's answer, since a dropped GPU is still asked for (see `gpuDropped`).
export interface ResourcesForm {
    memoryGib: number | null;
    cpus: number | null;
    privileged: boolean;
    gpu: boolean;
}

// Whether either asker put this token on the container: the owner (`hostRuntime`) or the approved environment.
const asked = (current: DeviceSandboxResources, token: string): boolean =>
    current.hostRuntime.includes(token) || current.overlayRuntime.includes(token);

// The form a dialog opens on. Caps round down to whole units, the contract's own direction; a switch is
// on when the container has the privilege or somebody asked for it.
export const formFrom = (current: DeviceSandboxResources): ResourcesForm => ({
    memoryGib: current.memoryBytes === undefined ? null : Math.floor(current.memoryBytes / GIB),
    cpus: current.cpus === undefined ? null : Math.max(1, Math.floor(current.cpus)),
    privileged: current.privileged || asked(current, PRIVILEGED_TOKEN),
    gpu: current.gpu || asked(current, GPU_TOKEN),
});

// Which switches aren't the owner's to throw. A directive the approved environment demands rides on the
// container regardless of the owner's list, so the switch is drawn on and disabled rather than silently
// overridden on Apply.
export interface ResourcesLocks {
    readonly privileged?: string | undefined;
    readonly gpu?: string | undefined;
}

const LOCKED = `Your approved environment requires this, so it can't be turned off here.`;

export const locksOf = (current: DeviceSandboxResources): ResourcesLocks => ({
    ...(current.overlayRuntime.includes(PRIVILEGED_TOKEN) ? { privileged: LOCKED } : {}),
    ...(current.overlayRuntime.includes(GPU_TOKEN) ? { gpu: LOCKED } : {}),
});

// A GPU asked for and not delivered: `--gpus` needs the NVIDIA runtime, and a host without it drops the
// flag. The form keeps the switch where the owner left it and says what became of the ask.
export const gpuDropped = (current: DeviceSandboxResources): boolean => asked(current, GPU_TOKEN) && !current.gpu;

// Why the form can't be applied yet, per field, as a sentence rather than a flag; an empty field is
// never a problem, it's the default.
export interface FormProblems {
    readonly memory?: string | undefined;
    readonly cpus?: string | undefined;
}

// `ceilingWhy` speaks only for bounds that carry a max.
const capProblem = (value: number | null, bounds: CapBounds, unit: string, floorWhy: string, ceilingWhy?: string): string | undefined => {
    if (value === null) {
        return undefined;
    }
    if (!Number.isInteger(value)) {
        return `Whole ${unit} only.`;
    }
    if (value < bounds.min) {
        return `At least ${bounds.min} ${unit}: ${floorWhy}`;
    }
    if (bounds.max !== undefined && value > bounds.max) {
        return `At most ${bounds.max} ${unit} on this computer${ceilingWhy === undefined ? `.` : `: ${ceilingWhy}`}`;
    }
    return undefined;
};

export const formProblems = (form: ResourcesForm, engine: EngineFacts | undefined): FormProblems => {
    const memory = capProblem(form.memoryGib, MEMORY_BOUNDS, `GiB`, `below that the sandbox's own toolchain stops fitting.`);
    const cpus = capProblem(form.cpus, cpuBounds(engine), `CPUs`, `a sandbox needs a core to run on.`, `that is every core its engine has.`);
    return { ...(memory === undefined ? {} : { memory }), ...(cpus === undefined ? {} : { cpus }) };
};

// What leaves on Apply: only what changed against the form the dialog opened on. `undefined` means
// nothing changed, and Apply is disabled on it.
export interface ResourcesAsk {
    memoryGib?: number | null;
    cpus?: number | null;
    privileged?: boolean;
    gpu?: boolean;
}

export const askFrom = (initial: ResourcesForm, form: ResourcesForm): ResourcesAsk | undefined => {
    const ask: ResourcesAsk = {
        ...(form.memoryGib === initial.memoryGib ? {} : { memoryGib: form.memoryGib }),
        ...(form.cpus === initial.cpus ? {} : { cpus: form.cpus }),
        ...(form.privileged === initial.privileged ? {} : { privileged: form.privileged }),
        ...(form.gpu === initial.gpu ? {} : { gpu: form.gpu }),
    };
    return Object.keys(ask).length === 0 ? undefined : ask;
};

// ---- the shape the form sends: whole, never a delta ----
// `ic` owns desired vs running: it reports the shape a container runs with (`shape`, the owner's ask it carries) and the
// shape saved for its next restart (`desired`), both WHOLE, and it is sent whole shapes back. Nothing here lays one
// over another; the form holds a shape and compares shapes.

// The shape the container runs with, in the form's vocabulary. From `shape` when the machine reported it (an agent that
// has `set-shape`); from docker's enforced share otherwise, the only reading an older agent gives, used for nothing but
// the old `reshape` op's delta.
export const runningShape = (current: DeviceSandboxResources): ResourcesForm => current.shape ?? formFrom(current);

// Whether two shapes say the same thing, field for field.
export const sameShape = (a: ResourcesForm, b: ResourcesForm): boolean =>
    a.memoryGib === b.memoryGib && a.cpus === b.cpus && a.privileged === b.privileged && a.gpu === b.gpu;

// A shape in a few words, e.g. "20 GiB memory · every CPU · not privileged · GPU"; the words `resourcesSummary` uses.
export const shapeSummary = (shape: ResourcesForm): string =>
    [
        shape.memoryGib === null ? `default memory` : `${shape.memoryGib} GiB memory`,
        shape.cpus === null ? `every CPU` : `${shape.cpus} ${shape.cpus === 1 ? `CPU` : `CPUs`}`,
        shape.privileged ? `privileged` : `not privileged`,
        shape.gpu ? `GPU` : `no GPU`,
    ].join(` · `);

// A number field's text, read back live. Not-a-number stays out entirely, so a field mid-edit ("1e")
// can't flip a cap to the default underneath the typing.
export const capFromField = (text: string): number | null | undefined => {
    const trimmed = text.trim();
    if (trimmed === ``) {
        return null;
    }
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
};
