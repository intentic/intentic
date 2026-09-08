import type { DeviceSandboxResources } from "./deviceDetail.js";

// Arithmetic behind SandboxResourcesDialog.vue: what the form holds, where it starts, what the machine
// accepts, and what leaves on Apply. Structural rather than the sandbox contract's own types, since
// `@intentic/ui` carries no domain dependency.

// The two directive tokens the switches stand for, in the run contract's own single-token spelling; used
// only to read a container's lists, never to validate one.
export const PRIVILEGED_TOKEN = `--privileged`;
export const GPU_TOKEN = `--gpus=all`;

/** The Docker engine's size, the ceiling every cap here is bounded by. */
export interface EngineFacts {
    memoryBytes: number;
    cpus: number;
}

// Rails a cap runs between, mirrored from the run contract's `localSandboxMemory`/`localSandboxCpus`: the
// contract clamps whatever arrives, so a stale rail here costs a refused keystroke, never a wrong cap.
const GIB = 1024 ** 3;
const MEMORY_FLOOR_GIB = 4;
const HOST_RESERVE_GIB = 3;

export interface CapBounds {
    readonly min: number;
    readonly max?: number | undefined;
}

export const memoryBounds = (engine: EngineFacts | undefined): CapBounds =>
    engine === undefined
        ? { min: MEMORY_FLOOR_GIB }
        : { min: MEMORY_FLOOR_GIB, max: Math.max(MEMORY_FLOOR_GIB, Math.floor(engine.memoryBytes / GIB) - HOST_RESERVE_GIB) };

export const cpuBounds = (engine: EngineFacts | undefined): CapBounds => (engine === undefined ? { min: 1 } : { min: 1, max: Math.max(1, Math.floor(engine.cpus)) });

// What the form holds. `null` is the default, shown as an empty field. The switches hold the ASK rather
// than docker's answer, since a dropped GPU is still asked for (see `gpuDropped`).
export interface ResourcesForm {
    memoryGib: number | null;
    cpus: number | null;
    privileged: boolean;
    gpu: boolean;
}

// Whether either asker put this token on the container: the owner (`hostRuntime`) or the approved environment.
const asked = (current: DeviceSandboxResources, token: string): boolean => current.hostRuntime.includes(token) || current.overlayRuntime.includes(token);

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

const capProblem = (value: number | null, bounds: CapBounds, unit: string, floorWhy: string, ceilingWhy: string): string | undefined => {
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
        return `At most ${bounds.max} ${unit} on this computer: ${ceilingWhy}`;
    }
    return undefined;
};

export const formProblems = (form: ResourcesForm, engine: EngineFacts | undefined): FormProblems => {
    const memory = capProblem(form.memoryGib, memoryBounds(engine), `GiB`, `below that the sandbox's own toolchain stops fitting.`, `the rest is what it keeps for itself.`);
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
