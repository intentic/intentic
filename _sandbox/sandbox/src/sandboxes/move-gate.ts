import { randomBytes } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import {
    type Device,
    type DeviceFlowLine,
    type DeviceMovePlan,
    type DeviceMoveStep,
    type DeviceSandbox,
    type DeviceSandboxFlow,
    type DeviceSandboxMove,
    deviceMoveStepOf,
} from "@intentic/sandbox-contract/schemas/devices";
import { DEVICE_FEATURE_SANDBOX_MOVE, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { createHeldAsks } from "../guard/held-asks.js";
import { type CliAnswer, jsonAnswer, refusalAnswer } from "../http/cli-answer.js";
import { opt } from "../opt.js";
import { askOwner, type OwnerCard, type OwnerCardDeps, withCase } from "./fleet-gate.js";

/* MOVING ONE SANDBOX TO ANOTHER OF THE OWNER'S COMPUTERS (2026-11-11, `sandboxes move`). The owner moved "translations"
from rog to z440 by hand: SSH, a tar of each volume, the at-rest key copied across, a Compose file written from memory.
This is the same move as one call behind one card, run from inside any of the owner's sandboxes that is linked to both
computers, with no SSH and no agent ever holding a key.

The order is the point, as with a create:
1. Resolve, from readings already held: which linked computer runs the sandbox (by its name or slug), and the target.
   Refused, with the sentence to act on, when either cannot move sandboxes (an older agent or ic: no `sandbox-move`),
   either has "Manage sandboxes" off, they are one computer, or the sandbox is this one (moving it would cut the very
   daemon orchestrating the move; run it from another sandbox).
2. The source's read-only plan (`move-out`, stage `plan`): what will be copied and how much, for the card.
3. The owner's card: sandbox, from, to, the size, and that it is offline for the copy.
4. On a yes, the two ic runs talk to each other directly: the target's long `move-prepare` checks its disk, pulls the
   image and builds the overlay while the sandbox still runs, then says where it listens and its ephemeral public key;
   the source's `move-out` gets that key, says its own, which `move-in` hands the waiting target, and dials. When no
   address answers (a firewall, a WSL NAT), the source listens on its loopback and this daemon pumps bytes between two
   `devices reach` tunnels: only ciphertext passes here. Public keys are carried between the flows and never printed
   back to the CLI, so no agent ever reads one.
5. Each ic rolls itself back on failure (the target removes what it made, the source starts the sandbox again), so this
   side only reports. Success is both sides saying `moved`. */

const APPROVE = "Move it";
const DECLINE = "Not now";

// How long the target's prepare may take to say where it listens: an image pull and an overlay build on a home line.
const READY_LIMIT_MS = 2 * 60 * 60 * 1000;

// The steps that carry a key or an address: kept here, never relayed to the CLI.
const PRIVATE_STEPS: ReadonlySet<string> = new Set(["ready", "key"]);

export type MoveManager = "ic" | "compose";

export interface MoveAsk {
    readonly name: string;
    readonly to: string;
    readonly manager: MoveManager | undefined;
    readonly why: string | undefined;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

// One end of the relay: a loopback port on one computer.
export interface RelayEnd {
    readonly device: string;
    readonly port: number;
}

export interface MoveGateDeps extends OwnerCardDeps {
    /** The linked computers as the readings already held describe them (heldHostDevices). */
    readonly devices: () => Promise<readonly Device[]>;
    /** Whether the card behind a connection has "Manage sandboxes on this device" on. */
    readonly manages: (card: string) => Promise<boolean>;
    readonly runFlow: (id: string, flow: DeviceSandboxFlow) => AsyncGenerator<DeviceFlowLine>;
    /** This sandbox's own slug, so it is never the one moved from inside itself. */
    readonly selfSlug: () => string | undefined;
    /** Pumps bytes between two computers' loopback ports through `devices reach` tunnels; `close` ends it. */
    readonly relay: (from: RelayEnd, to: RelayEnd) => Promise<{ readonly close: () => Promise<void> }>;
    readonly moveId?: () => string;
}

/** One progress line for the CLI: which side said it, and either ic's step (with its fields) or its narration. */
export type MoveProgress = { readonly side: "source" | "target" } & (Omit<DeviceMoveStep, "publicKey" | "plan"> | { readonly text: string });

/** What resolving the ask came to: a refusal, or the two computers and the sandbox. */
export interface MoveRoute {
    readonly slug: string;
    readonly label: string;
    readonly source: string;
    readonly target: string;
}

const moves = createHeldAsks<CliAnswer | undefined>();

const gigabytes = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

// The progress a CLI may see of one flow line: private steps dropped, and any key a step carries left out.
export const progressOf = (side: "source" | "target", line: DeviceFlowLine): MoveProgress | undefined => {
    if (line.kind !== "line") {
        return undefined;
    }
    const step = deviceMoveStepOf(line.text);
    if (step === undefined) {
        return line.text.trim() === "" ? undefined : { side, text: line.text };
    }
    if (PRIVATE_STEPS.has(step.step)) {
        return undefined;
    }
    const { publicKey: _key, plan: _plan, ...rest } = step;
    return { side, ...rest };
};

const doorsWith = (devices: readonly Device[], name: string): { readonly device: Device; readonly box: DeviceSandbox }[] => {
    const wanted = name.trim().toLowerCase();
    return devices.flatMap((device) =>
        device.hostId === undefined
            ? []
            : (device.sandboxes ?? []).filter((box) => box.slug === wanted || box.name?.toLowerCase() === wanted).map((box) => ({ device, box })),
    );
};

const targetOf = (devices: readonly Device[], to: string): Device[] => {
    const exact = devices.filter((device) => device.hostId === to);
    if (exact.length > 0) {
        return exact;
    }
    const wanted = to.toLowerCase();
    return devices.filter((device) => device.hostId !== undefined && (device.card?.toLowerCase() === wanted || device.label.toLowerCase() === wanted));
};

const sameComputer = (a: Device, b: Device): boolean => a.hostId === b.hostId || (a.machineId !== undefined && a.machineId === b.machineId);

type Found<T> = T | CliAnswer;

// The one sandbox the ask names, and the connection that reports it running.
const sandboxNamed = (devices: readonly Device[], name: string): Found<{ readonly device: Device & { hostId: string }; readonly box: DeviceSandbox }> => {
    const found = doorsWith(devices, name);
    const slugs = [...new Set(found.map((door) => door.box.slug))];
    if (slugs.length > 1) {
        return refusalAnswer(409, "ambiguous", `${slugs.length} sandboxes answer to "${name}" (${slugs.join(", ")}): name the one to move by its slug.`);
    }
    const [first] = found;
    const hostId = first?.device.hostId;
    if (first === undefined || hostId === undefined) {
        const known = devices.flatMap((device) => (device.sandboxes ?? []).map((box) => `${box.name ?? box.slug} (${device.hostId ?? device.label})`));
        return refusalAnswer(
            404,
            "no_such_sandbox",
            `No computer linked to this sandbox runs a sandbox called "${name}". Running now: ${known.join(", ") || "none that this sandbox can see"}.`,
        );
    }
    return { device: { ...first.device, hostId }, box: first.box };
};

// The one connection `to` names: its id, else the card or label of exactly one.
const computerNamed = (devices: readonly Device[], to: string): Found<Device & { hostId: string }> => {
    const targets = targetOf(devices, to);
    const [target, ...more] = targets;
    if (more.length > 0) {
        return refusalAnswer(
            409,
            "ambiguous_device",
            `"${to}" has several connections (${targets.map((device) => device.hostId).join(", ")}): name the one whose Docker should run it.`,
        );
    }
    const hostId = target?.hostId;
    if (target === undefined || hostId === undefined) {
        const linked = devices.flatMap((device) => (device.hostId === undefined ? [] : [device.hostId]));
        return refusalAnswer(409, "no_such_device", `"${to}" is not a computer this sandbox can reach. Linked: ${linked.join(", ") || "none"}.`);
    }
    return { ...target, hostId };
};

// Why one end cannot take part, or undefined when it can.
const unableEnd = async (deps: Pick<MoveGateDeps, "manages">, device: Device & { hostId: string }): Promise<CliAnswer | undefined> => {
    if (device.online !== true) {
        return refusalAnswer(409, "offline", `${device.hostId} is not connected right now, and a move needs both computers. Nothing was changed.`);
    }
    if (!deviceSupports(device.facts, DEVICE_FEATURE_SANDBOX_MOVE)) {
        return refusalAnswer(
            409,
            "unsupported",
            `The agent on ${device.hostId}, or the ic it drives, is too old to move sandboxes between computers. Nothing was changed. Update that computer's agent (\`intentic-machine upgrade\` there), then try again.`,
        );
    }
    const card = device.card ?? device.hostId;
    return (await deps.manages(card))
        ? undefined
        : refusalAnswer(
              409,
              "switch_off",
              `"Manage sandboxes on this device" is off for ${device.hostId}, so this sandbox may not move sandboxes there. Ask the owner to turn it on: \`capabilities request ${card} --set sandboxes=on --why "…"\`.`,
          );
};

// Every refusal before the card, in the order a person would fix them: what and where first, then whether both can.
const resolveMove = async (deps: Pick<MoveGateDeps, "devices" | "manages" | "selfSlug">, ask: Pick<MoveAsk, "name" | "to">): Promise<Found<MoveRoute>> => {
    const devices = await deps.devices();
    const named = sandboxNamed(devices, ask.name);
    if ("status" in named) {
        return named;
    }
    const { slug } = named.box;
    const label = named.box.name ?? slug;
    if (slug === deps.selfSlug()) {
        return refusalAnswer(
            409,
            "self",
            `"${label}" is this sandbox, the one this conversation runs in: moving it would stop the daemon running the move halfway. Run \`sandboxes move\` from another of the owner's sandboxes linked to both computers.`,
        );
    }
    const target = computerNamed(devices, ask.to);
    if ("status" in target) {
        return target;
    }
    if (sameComputer(named.device, target)) {
        return refusalAnswer(409, "same_device", `"${label}" already runs on ${target.hostId}: there is nothing to move.`);
    }
    const unable = (await unableEnd(deps, named.device)) ?? (await unableEnd(deps, target));
    return unable ?? { slug, label, source: named.device.hostId, target: target.hostId };
};

// The source's own plan, read before the card so the card names the size. Nothing is touched by it.
const planMove = async (
    deps: Pick<MoveGateDeps, "runFlow">,
    route: MoveRoute,
    id: string,
): Promise<{ readonly plan: DeviceMovePlan } | CliAnswer> => {
    const lines: string[] = [];
    let plan: DeviceMovePlan | undefined;
    let failure: string | undefined;
    for await (const line of deps.runFlow(route.source, { op: "move-out", slug: route.slug, move: { id, stage: "plan" } })) {
        if (line.kind === "error") {
            failure = line.message;
        } else if (line.kind === "line") {
            const step = deviceMoveStepOf(line.text);
            if (step?.step === "plan" && step.plan !== undefined) {
                ({ plan } = step);
            } else {
                lines.push(line.text);
            }
        }
    }
    if (failure !== undefined || plan === undefined) {
        return jsonAnswer(502, {
            error: { type: "plan_failed", message: `${route.source} could not plan the move of "${route.label}": ${failure ?? "its ic said no plan"}` },
            lines,
        });
    }
    return { plan };
};

const moveCard = (ask: MoveAsk, route: MoveRoute, bytes: number): OwnerCard => ({
    key: [route.slug, route.source, route.target, ask.manager ?? "ic"].join("\u0000"),
    question: `Move the sandbox "${route.label}" from ${route.source} to ${route.target}?`,
    header: "Move",
    approve: {
        label: APPROVE,
        description: withCase(
            `Copies its files (about ${gigabytes(bytes)}) and its keys from ${route.source} to ${route.target}, encrypted end to end, and starts it there` +
                `${ask.manager === "compose" ? " under Docker Compose" : ""}. The sandbox is offline for the whole copy. ${route.source} keeps its stopped copy for 7 days; ` +
                "if anything fails before it is up on the other side, it starts again where it was.",
            ask.why,
        ),
    },
    decline: { label: DECLINE, description: "Nothing is moved; the sandbox keeps running where it is." },
    waiting:
        `Still waiting for the owner: a card asks them to move "${route.label}" to ${route.target}, and nothing has been touched yet. The card stays up until they answer. ` +
        "Make exactly the same call again to collect their answer, or carry on and end your turn: if they say yes after, you are woken to make the call again.",
    declined: `The owner wants "${route.label}" left on ${route.source}. Leave it, and do not ask again to move it.`,
    unanswered: "The turn ended before the owner answered: nothing was moved.",
    told: {
        doing: `moving the sandbox "${route.label}" from ${route.source} to ${route.target}`,
        notYet: "Nothing has been moved yet",
        again: "Make the same call now, with the same name and computer.",
        declinedSo: "nothing was moved",
        refrain: `Leave it on ${route.source}, and do not ask again to move "${route.label}".`,
    },
});

// How one side's flow ended: whether it said `moved`, and why not.
interface Ended {
    readonly moved: boolean;
    readonly failure: string | undefined;
    // The source sent everything but never heard the target's verdict, and stayed stopped (see DeviceMoveStepSchema).
    readonly ambiguous?: boolean;
}

// One flow consumed in the background: its progress relayed, its steps handed to `onStep`, its ending kept.
interface Watched {
    readonly done: Promise<Ended>;
    readonly stop: () => void;
}

// What one line says about how the flow is going: whether it reached `moved`, and a failure if it names one.
const verdictOf = (line: DeviceFlowLine, step: DeviceMoveStep | undefined): Ended => {
    if (line.kind === "error") {
        return { moved: false, failure: line.message };
    }
    const failed = step?.step === "failed" || step?.step === "unreachable";
    return { moved: step?.step === "moved", failure: failed ? (step.reason ?? step.step) : undefined };
};

const watch = (
    flow: AsyncGenerator<DeviceFlowLine>,
    side: "source" | "target",
    onProgress: (progress: MoveProgress) => void,
    onStep: (step: DeviceMoveStep) => void,
): Watched => {
    let stopped = false;
    const done = (async (): Promise<Ended> => {
        let moved = false;
        let ambiguous = false;
        let failure: string | undefined;
        try {
            for await (const line of flow) {
                const step = line.kind === "line" ? deviceMoveStepOf(line.text) : undefined;
                const said = verdictOf(line, step);
                moved ||= said.moved;
                ambiguous ||= step?.ambiguous === true;
                failure ??= said.failure;
                if (step !== undefined) {
                    onStep(step);
                }
                const progress = progressOf(side, line);
                if (progress !== undefined && !stopped) {
                    onProgress(progress);
                }
            }
        } catch (error) {
            failure ??= errorMessage(error);
        }
        return { moved: moved && failure === undefined, failure, ambiguous };
    })();
    return {
        done,
        stop: () => {
            stopped = true;
            void flow.return(undefined);
        },
    };
};

// Where the target listens and the key it holds, as its `ready` line said.
interface Ready {
    readonly publicKey: string;
    readonly listen: readonly string[];
    readonly port: number;
}

// The target's prepare, started and watched until it is ready to take the sandbox (or has stopped trying).
const prepareTarget = async (
    deps: Pick<MoveGateDeps, "runFlow">,
    route: MoveRoute,
    move: MoveStart,
    onProgress: (progress: MoveProgress) => void,
): Promise<{ readonly target: Watched; readonly ready: { readonly ok: Ready } | { readonly failure: string } }> => {
    let resolveReady: (ready: Ready) => void = () => undefined;
    const readied = new Promise<Ready>((resolve) => {
        resolveReady = resolve;
    });
    const flowMove: DeviceSandboxMove = { id: move.id, plan: move.plan };
    if (move.manager !== undefined) {
        flowMove.manager = move.manager;
    }
    const target = watch(deps.runFlow(route.target, { op: "move-prepare", slug: route.slug, move: flowMove }), "target", onProgress, (step) => {
        if (step.step === "ready" && step.publicKey !== undefined && step.port !== undefined) {
            resolveReady({ publicKey: step.publicKey, listen: step.listen ?? [], port: step.port });
        }
    });
    let timer: NodeJS.Timeout | undefined;
    const first = await Promise.race([
        readied.then((ok) => ({ ok })),
        target.done.then((ended) => ({ failure: ended.failure ?? "it stopped before it was ready" })),
        new Promise<{ readonly failure: string }>((resolve) => {
            timer = setTimeout(() => resolve({ failure: "it did not get ready within two hours" }), READY_LIMIT_MS);
            timer.unref?.();
        }),
    ]);
    clearTimeout(timer);
    return { target, ready: first };
};

/** What the move is, once the owner said yes. */
export interface MoveStart {
    readonly id: string;
    readonly plan: DeviceMovePlan;
    readonly manager: MoveManager | undefined;
}

/** The move itself, after the owner's yes: both ic runs started and watched, relayed when they cannot meet directly. */
export const runMove = async (
    deps: Pick<MoveGateDeps, "runFlow" | "relay">,
    route: MoveRoute,
    move: MoveStart,
    onProgress: (progress: MoveProgress) => void,
): Promise<CliAnswer> => {
    const prepared = await prepareTarget(deps, route, move, onProgress);
    const { target } = prepared;
    if ("failure" in prepared.ready) {
        target.stop();
        return refusalAnswer(
            502,
            "target_failed",
            `${route.target} could not get ready to take "${route.label}": ${prepared.ready.failure}. The sandbox was never stopped on ${route.source}.`,
        );
    }
    const ready = prepared.ready.ok;
    const handOffs: Promise<string | undefined>[] = [];
    let relay: { readonly close: () => Promise<void> } | undefined;
    const source = watch(
        deps.runFlow(route.source, {
            op: "move-out",
            slug: route.slug,
            move: { id: move.id, stage: "send", peer: ready.publicKey, connect: [...ready.listen], listen: true },
        }),
        "source",
        onProgress,
        (step) => {
            if (step.step === "key" && step.publicKey !== undefined) {
                handOffs.push(drain(deps.runFlow(route.target, { op: "move-in", slug: route.slug, move: { id: move.id, peer: step.publicKey } }), "handing over the key"));
            } else if (step.step === "listening" && step.port !== undefined) {
                onProgress({ side: "source", step: "relay" });
                const opened = deps.relay({ device: route.source, port: step.port }, { device: route.target, port: ready.port });
                handOffs.push(
                    opened.then(
                        (pump) => {
                            relay = pump;
                            return undefined;
                        },
                        (error: Error) => `the relay between them: ${error.message}`,
                    ),
                );
            }
        },
    );
    const sent = await source.done;
    // A source that failed or never met the target leaves the target waiting for nobody: it gives up by itself and
    // removes what it made, so this side stops watching it rather than holding the CLI for its timeout. A source that
    // sent everything and lost the verdict (`ambiguous`) stayed stopped on purpose: the target's own ending decides, and
    // only a target that failed gets the sandbox started again where it was.
    const awaitTarget = sent.moved || sent.ambiguous === true;
    if (!awaitTarget) {
        target.stop();
    }
    const received: Ended = awaitTarget ? await target.done : { moved: false, failure: undefined };
    if (sent.ambiguous === true && !received.moved) {
        handOffs.push(drain(deps.runFlow(route.source, { op: "start", slug: route.slug }), `starting it again on ${route.source}`));
    }
    const handOffFailures = (await Promise.all(handOffs)).filter((failure): failure is string => failure !== undefined);
    await relay?.close();
    return outcomeOf(route, move, sent, received, handOffFailures);
};

// The CLI's answer from how both sides ended.
const outcomeOf = (route: MoveRoute, move: MoveStart, sent: Ended, received: Ended, handOffFailures: readonly string[]): CliAnswer => {
    if (received.moved && (sent.moved || sent.ambiguous === true)) {
        // An ambiguous source never set its copy aside as `.moved`: it stays stopped under its own name until removed.
        const left = sent.moved ? undefined : `${route.source} did not hear that it arrived, so its stopped copy keeps its own name there; remove it once you are sure.`;
        return jsonAnswer(200, { moved: route.label, slug: route.slug, from: route.source, to: route.target, manager: move.manager ?? "ic", ...opt("note", left) });
    }
    const reasons = [
        sent.failure === undefined ? undefined : `${route.source}: ${sent.failure}`,
        received.failure === undefined ? undefined : `${route.target}: ${received.failure}`,
        ...handOffFailures,
    ].filter((reason): reason is string => reason !== undefined);
    const where =
        sent.ambiguous === true
            ? `It did not come up on ${route.target}, which removes what it made; ${route.source} was asked to start it again where it was.`
            : `It is back on ${route.source} as it was; ${route.target} removes whatever it had made.`;
    return refusalAnswer(502, "move_failed", `"${route.label}" was not moved. ${where} ${reasons.join("; ") || "Neither side said why."}`);
};

// A short flow run to its end: its failure, named by what it was doing, or undefined.
const drain = async (flow: AsyncGenerator<DeviceFlowLine>, doing: string): Promise<string | undefined> => {
    let failure: string | undefined;
    try {
        for await (const line of flow) {
            if (line.kind === "error") {
                failure = `${doing}: ${line.message}`;
            }
        }
    } catch (error) {
        failure = `${doing}: ${errorMessage(error)}`;
    }
    return failure;
};

/** Everything before the move: resolved, planned and approved, or the answer that stops it. */
export const approveMove = async (
    deps: MoveGateDeps,
    ask: MoveAsk,
): Promise<{ readonly route: MoveRoute; readonly id: string; readonly plan: DeviceMovePlan } | CliAnswer> => {
    const route = await resolveMove(deps, ask);
    if ("status" in route) {
        return route;
    }
    const id = deps.moveId?.() ?? randomBytes(8).toString("hex");
    const planned = await planMove(deps, route, id);
    if ("status" in planned) {
        return planned;
    }
    const refused = await askOwner(deps, ask, moves, moveCard(ask, route, planned.plan.bytes));
    return refused ?? { route, id, plan: planned.plan };
};
