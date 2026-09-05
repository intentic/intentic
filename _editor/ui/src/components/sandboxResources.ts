import type { DeviceSandboxResources } from "./deviceDetail.js";

/* THE ARITHMETIC BEHIND SandboxResourcesDialog.vue: what the form holds, where it starts from, what the machine
 * will accept, and what leaves when Apply is pressed.
 *
 * It is a module of its own for the reason deviceDetail.ts is: every judgement here is a pure function of two
 * small records, and both apps ask exactly the same questions of them. The dialog stays a template that draws
 * four rows and two sentences; the desktop app and the web tab hand it the container's current share and the
 * machine's engine, and get back an ask they forward without reading.
 *
 * Shapes are STRUCTURAL rather than the sandbox contract's own (`@intentic/ui` carries no domain dependency):
 * a SandboxResources satisfies `DeviceSandboxResources`, a `ResourcesAsk` satisfies SandboxResourcesAsk. */

/* The two directive tokens the switches stand for, in the run contract's own single-token spelling
 * (@intentic/sandbox-run RUNTIME_DIRECTIVES). Named here only to READ a container's lists, which is the whole of
 * what a form may do with them: the machine that runs the reshape validates the tokens, this only asks which of
 * them are already there and who put them there. */
export const PRIVILEGED_TOKEN = `--privileged`;
export const GPU_TOKEN = `--gpus=all`;

/** The Docker engine's size, the ceiling every cap here is bounded by: HostFacts.engine in the sandbox contract. */
export interface EngineFacts {
    memoryBytes: number;
    cpus: number;
}

/* THE RAILS A CAP RUNS BETWEEN, mirrored from the run contract (localSandboxMemory / localSandboxCpus in
 * @intentic/sandbox-run): whole GiB from a 4 GiB floor up to the engine minus the 3 GiB the host keeps for
 * itself, whole cores from one to the engine's count. Restated rather than imported for the kit's usual reason,
 * and only as the field's rails: the contract clamps whatever arrives, so a number here that fell behind it costs
 * a refused keystroke, never a wrong cap. An engine that could not be measured leaves the ceiling open. */
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

/* WHAT THE FORM HOLDS. `null` is the DEFAULT, said as an empty field: for memory the share the machine derives
 * (everything but what the host keeps), for CPUs every core. The two switches hold the ASK rather than docker's
 * answer, because a switch is a thing to set: a GPU the owner asked for on a host that could not provide it is
 * still asked for, and the form says so beside it (`gpuDropped`) rather than drawing the switch off and letting
 * Apply re-request what was never withdrawn. */
export interface ResourcesForm {
    memoryGib: number | null;
    cpus: number | null;
    privileged: boolean;
    gpu: boolean;
}

// Whether either asker put this token on the container: the owner (hostRuntime) or the approved environment.
const asked = (current: DeviceSandboxResources, token: string): boolean => current.hostRuntime.includes(token) || current.overlayRuntime.includes(token);

/* The form a dialog opens on: the container as it runs now. Caps round DOWN to whole units, the contract's own
 * direction (a cap that rounded up would offer bytes the machine does not grant); a switch is on when the
 * container has the privilege OR somebody asked for it, which differ only for the dropped GPU above. */
export const formFrom = (current: DeviceSandboxResources): ResourcesForm => ({
    memoryGib: current.memoryBytes === undefined ? null : Math.floor(current.memoryBytes / GIB),
    cpus: current.cpus === undefined ? null : Math.max(1, Math.floor(current.cpus)),
    privileged: current.privileged || asked(current, PRIVILEGED_TOKEN),
    gpu: current.gpu || asked(current, GPU_TOKEN),
});

/* WHICH SWITCHES ARE NOT THE OWNER'S TO THROW, each with the sentence the form shows for it.
 *
 * A directive the approved environment demands (the Docker capability's `--privileged`, a local model card's
 * GPU) rides on the container whatever the owner's own list says: a reshape can only add to it or withdraw the
 * owner's half. So the switch is drawn on and disabled, with the reason, rather than drawn live and silently
 * ignored on Apply, which is the drift the run contract's provenance stamp exists to make visible. */
export interface ResourcesLocks {
    readonly privileged?: string | undefined;
    readonly gpu?: string | undefined;
}

const LOCKED = `Your approved environment requires this, so it can't be turned off here.`;

export const locksOf = (current: DeviceSandboxResources): ResourcesLocks => ({
    ...(current.overlayRuntime.includes(PRIVILEGED_TOKEN) ? { privileged: LOCKED } : {}),
    ...(current.overlayRuntime.includes(GPU_TOKEN) ? { gpu: LOCKED } : {}),
});

/* A GPU that was asked for and did not arrive: the one switch whose ask and answer can disagree. `--gpus` is not
 * device exposure but the NVIDIA runtime injecting the host's driver libraries, so a host without that runtime
 * drops the flag and the sandbox starts without it (the run contract's optional-directive probe). The form keeps
 * the switch where the owner left it and says what became of the ask. */
export const gpuDropped = (current: DeviceSandboxResources): boolean => asked(current, GPU_TOKEN) && !current.gpu;

/* WHY THE FORM CANNOT BE APPLIED YET, per field, or nothing when it can. Sentences rather than a flag because
 * the field shows its own: a fraction, or a cap outside the rails above. An empty field is never a problem, it
 * is the default. */
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

/* WHAT LEAVES WHEN APPLY IS PRESSED: only what CHANGED against the form the dialog opened on, in the shape the
 * sandbox contract's SandboxResourcesAsk takes. Absent means "leave it", `null` on a cap means "back to the
 * default", which the machine spells as `ic`'s `default` and the run contract as an empty seed. Nothing changed
 * is `undefined`, and the dialog's Apply is disabled on it: a reshape with nothing to change is a restart for
 * nothing, and the machine would refuse it anyway. */
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

/* A NUMBER FIELD'S TEXT, READ BACK. Empty is the default (`null`); anything else is a number, including the
 * fractions and negatives the browser's own `min`/`max`/`step` only advise against, which is why formProblems
 * judges the result rather than trusting the field. Not-a-number stays out entirely: a field mid-edit ("1e")
 * must not flip a cap to the default underneath the typing. */
export const capFromField = (text: string): number | null | undefined => {
    const trimmed = text.trim();
    if (trimmed === ``) {
        return null;
    }
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
};
