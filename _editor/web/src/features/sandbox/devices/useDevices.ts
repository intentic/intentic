import {
    type CardlessHost,
    type Device,
    type DeviceAgentOp,
    type DeviceCommand,
    type DeviceCommandResult,
    type DeviceFlowLine,
    type IntenticLine,
    type DeviceSandboxFlowInput,
    type DeviceSandboxOp,
    type SandboxResourcesAsk,
    type SandboxShape,
    type SandboxShapeWhen,
    hostHoldingPath,
    hostRunningSandbox,
} from "@intentic/sandbox-contract";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type Ref } from "vue";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { StreamEndedError, StreamFailedError, untilResult } from "../../../lib/intenticStream";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { useSyncStatus } from "./sync/useSyncStatus";

// Devices the daemon can see, merging both report paths (see hosts/device-reports.ts). Pushed on the `hosts` domain
// when a machine's reading actually moves. The poll stays beside the push because the reading is a snapshot the daemon
// caches between polls and the rows age it against `readAt`, so it is also what re-reads a machine that went quiet
// without a socket event.

const POLL_MS = 10_000;

// Callers opt into polling; a non-polling reader still gets the shared cache, refreshed once on mount.
export function useDevices({ poll = true }: { poll?: boolean } = {}): {
    devices: ComputedRef<Device[]>;
    /** Device keys no capability card holds, which no row stands for; empty from a daemon older than the field. */
    cardlessHosts: ComputedRef<CardlessHost[]>;
    /** When this list landed here: the clock every freshness verdict on a device is judged against. */
    readAt: ComputedRef<number>;
    error: ComputedRef<string | undefined>;
    isLoading: Ref<boolean>;
    refetch: () => void;
    /** The same re-read, settling once the answer has landed: for a caller that says "looking" until it has. */
    reread: () => Promise<void>;
} {
    const { query, error } = useSandboxQuery({ ...rpcQuery(`system.devices`), refetchInterval: poll ? POLL_MS : false });
    return {
        devices: computed(() => query.data.value?.devices ?? []),
        cardlessHosts: computed(() => query.data.value?.cardlessHosts ?? []),
        // Restored with the cache on reload, so a hydrated list is aged from when it was actually read, not from now.
        readAt: computed(() => query.dataUpdatedAt.value),
        error,
        // True only for the first fetch; a refetch must never blank an already-populated list.
        isLoading: query.isLoading,
        refetch: () => void query.refetch(),
        reread: async () => {
            await query.refetch();
        },
    };
}

// One string field from a loosely-parsed stream frame, or undefined.
const frameText = (line: Record<string, unknown>, key: string): string | undefined => (typeof line[key] === `string` ? line[key] : undefined);

// Payload shared by every device-sandbox op, all issued through one streaming call. `onLine` gets progress
// as it prints; `hash` is rebuild's digest, `shape`/`when` are set-shape's whole shape and its timing, `resources`
// the old reshape op's delta (sent only to an agent older than set-shape, see shapeFlow), `to` the older version a
// rollback goes back to (sent only to an agent advertising `rollback-to`, see rollbackChoices).
export interface DeviceSandboxPayload {
    hash?: string | undefined;
    to?: string | undefined;
    shape?: SandboxShape | undefined;
    when?: SandboxShapeWhen | undefined;
    resources?: SandboxResourcesAsk | undefined;
    // The short-lived setup code reconnect redeems on the host machine for a drifted container's missing values.
    setupCode?: string | undefined;
    onLine?: ((line: string) => void) | undefined;
    // Set when the op is aimed at the sandbox relaying it: the daemon dies mid-stream, so a lost connection is the
    // op landing rather than a failure. Only the caller knows which sandbox is serving the page.
    severing?: boolean | undefined;
    // The owner asking, as they restart the sandbox relaying this, for the turns it cuts to run again once it is back.
    resumeTurns?: boolean | undefined;
    // Another of the owner's sandboxes to carry the call, by id: one whose own Devices list reaches the machine when the
    // active one's does not (the switcher's removal). Absent is the active sandbox; `hostId` is that sandbox's key.
    at?: string | undefined;
}

// hash/to/shape/when/resources/setupCode/resumeTurns are set only when present; the schema rejects an explicit undefined.
const flowInput = (
    hostId: string,
    slug: string,
    op: DeviceSandboxOp,
    { hash, to, shape, when, resources, setupCode, resumeTurns }: DeviceSandboxPayload,
): DeviceSandboxFlowInput => {
    const input: DeviceSandboxFlowInput = { id: hostId, slug, op };
    if (hash !== undefined) {
        input.hash = hash;
    }
    if (to !== undefined) {
        input.to = to;
    }
    if (shape !== undefined) {
        input.shape = shape;
    }
    if (when !== undefined) {
        input.when = when;
    }
    if (resources !== undefined) {
        input.resources = resources;
    }
    if (setupCode !== undefined) {
        input.setupCode = setupCode;
    }
    if (resumeTurns === true) {
        input.resumeTurns = true;
    }
    return input;
};

// Stands in for the device's own sentence when the op that succeeded took the connection carrying it down: the
// daemon relaying the call lived in the container the call acted on, so no result frame can ever arrive.
const severedOutcome = (op: DeviceSandboxOp, slug: string): string =>
    op === `remove` ? t(`sandbox.useDevices.removedSevered`, { slug }) : t(`sandbox.useDevices.severed`, { slug, op: OP_WORDS[op]() });

// Each op as the sentence above names it: the op's own name in English, a noun in the reader's language.
const OP_WORDS: Readonly<Record<DeviceSandboxOp, () => string>> = {
    start: () => t(`sandbox.useDevices.ops.start`),
    stop: () => t(`sandbox.useDevices.ops.stop`),
    restart: () => t(`sandbox.useDevices.ops.restart`),
    prepare: () => t(`sandbox.useDevices.ops.prepare`),
    "prepare-background": () => t(`sandbox.useDevices.ops.prepareBackground`),
    update: () => t(`sandbox.useDevices.ops.update`),
    rebuild: () => t(`sandbox.useDevices.ops.rebuild`),
    rollback: () => t(`sandbox.useDevices.ops.rollback`),
    reshape: () => t(`sandbox.useDevices.ops.reshape`),
    "set-shape": () => t(`sandbox.useDevices.ops.setShape`),
    "forget-shape": () => t(`sandbox.useDevices.ops.forgetShape`),
    remove: () => t(`sandbox.useDevices.ops.remove`),
    logs: () => t(`sandbox.useDevices.ops.logs`),
    reconnect: () => t(`sandbox.useDevices.ops.reconnect`),
    create: () => t(`sandbox.useDevices.ops.create`),
    "runner-up": () => t(`sandbox.useDevices.ops.runnerUp`),
    "runner-remove": () => t(`sandbox.useDevices.ops.runnerRemove`),
};

// A flow's printed lines, as the caller's onLine takes them; the terminal frames speak through the result or the throw.
const printedLines =
    (onLine: ((line: string) => void) | undefined) =>
    (line: IntenticLine): void => {
        const text = line.kind === `line` ? frameText(line, `text`) : undefined;
        if (text !== undefined) {
            onLine?.(text);
        }
    };

/**
 * A flow's stream that broke, or ended, before the device's last word: the machine carries on with nobody listening,
 * so this is never its refusal. `transport` is what the browser said when the stream broke; absent when it just ended.
 */
export class DeviceFlowLostError extends Error {
    constructor(readonly transport: string | undefined) {
        super(
            transport === undefined
                ? t(`sandbox.useDevices.lostContact`)
                : t(`sandbox.useDevices.lostContactSaid`, { transport }),
        );
    }
}

// A stream ending without a terminal frame means the connection dropped, not that the operation stopped;
// the next fleet read reflects the real outcome. For an op that `severs` that drop IS its ending, answered as
// undefined; any other op's drop is lost contact. A refusal the device sent throws as itself, severing or not.
const outcomeOf = async (
    frames: AsyncIterable<DeviceFlowLine>,
    onLine: ((line: string) => void) | undefined,
    severs: boolean,
): Promise<string | undefined> => {
    let outcome: string | undefined;
    try {
        outcome = frameText(await untilResult(frames, { failed: () => t(`sandbox.useDevices.opFailed`), onLine: printedLines(onLine) }), `message`);
    } catch (error) {
        if (error instanceof StreamFailedError) {
            throw error;
        }
        if (severs) {
            return undefined;
        }
        // Read by shape: the browser's own abort is a DOMException, which not every DOM makes an Error.
        const browser = error instanceof StreamEndedError ? `` : messageOr(error, ``);
        throw new DeviceFlowLostError(browser === `` ? undefined : browser);
    }
    if (outcome !== undefined || severs) {
        return outcome;
    }
    throw new DeviceFlowLostError(undefined);
};

export async function manageDeviceSandbox(hostId: string, slug: string, op: DeviceSandboxOp, payload: DeviceSandboxPayload = {}): Promise<string> {
    const frames = await sandboxRpc.system.manageDeviceSandbox(
        flowInput(hostId, slug, op, payload),
        payload.at === undefined ? undefined : { context: { at: payload.at } },
    );
    return (await outcomeOf(frames, payload.onLine, payload.severing === true)) ?? severedOutcome(op, slug);
}

/**
 * A swap aimed at the sandbox serving this page (an update, a rollback, a rebuild), which is relayed by the daemon it
 * replaces. The device's own sentence when it got to send one, which means nothing was swapped out from under this page
 * (an update already in place, say); `undefined` when the stream died at the cutover, which is the swap happening. A
 * refusal the device sent still throws.
 */
export async function swapServingSandbox(hostId: string, slug: string, op: DeviceSandboxOp, payload: DeviceSandboxPayload = {}): Promise<string | undefined> {
    const frames = await sandboxRpc.system.manageDeviceSandbox(flowInput(hostId, slug, op, payload));
    return outcomeOf(frames, payload.onLine, true);
}

// Update/restart kills the process serving the request, so an untimely stream end here is success, not
// manageDeviceSandbox's lost-connection case. `settled` only says a result frame arrived; the agent version
// on the next poll is the real answer.
export async function runDeviceAgentFlow(
    hostId: string,
    op: DeviceAgentOp,
    { onLine }: { onLine?: (line: string) => void } = {},
): Promise<{ message: string | undefined; settled: boolean }> {
    const frames = await sandboxRpc.system.runDeviceAgentFlow({ id: hostId, op });
    // An `error` frame means the device refused (its switch off, or its agent too old), not a dropped connection.
    const result = await untilResult(frames, { failed: () => t(`sandbox.useDevices.agentUpdateRefused`), onLine: printedLines(onLine) }).catch(
        (error: unknown) => {
            if (error instanceof StreamEndedError) {
                return undefined;
            }
            throw error;
        },
    );
    const message = result === undefined ? undefined : frameText(result, `message`);
    return { message, settled: message !== undefined };
}

// What a command acts on, beyond its own name: a pairing to scope the sync switches to, for `sync-install` which
// half to enroll and the folder on that device, and for the two per-port mirror switches the one number they are
// about. No token and no command line — the daemon builds both.
export interface DeviceCommandAsk {
    sandboxId?: string | undefined;
    mode?: `sync` | `mirror` | undefined;
    localDir?: string | undefined;
    port?: number | undefined;
}

// Runs one device CLI action by a closed-set name; the daemon builds the argv (hosts/device-commands.ts),
// never forwarding free text. `ok: false` is the device's own refusal as a result; only an unreachable
// device rejects the promise.
export async function runDeviceCommand(hostId: string, command: DeviceCommand, ask: DeviceCommandAsk = {}): Promise<DeviceCommandResult> {
    return sandboxRpc.system.runDeviceCommand({
        id: hostId,
        command,
        ...(ask.sandboxId === undefined ? {} : { sandboxId: ask.sandboxId }),
        ...(ask.mode === undefined ? {} : { mode: ask.mode }),
        ...(ask.localDir === undefined ? {} : { localDir: ask.localDir }),
        ...(ask.port === undefined ? {} : { port: ask.port }),
    });
}

// The same call for a command that takes its own answer down with it: `dev-restart` restarts the container serving
// this request, so the connection dropping IS the expected ending, reported as `undefined`. Anything the daemon
// managed to answer — a refusal, a bad request, the device being unreachable — still throws, since a reply that
// arrived is a reply about what happened.
export async function runSeveringDeviceCommand(hostId: string, command: DeviceCommand): Promise<DeviceCommandResult | undefined> {
    try {
        return await runDeviceCommand(hostId, command);
    } catch (error) {
        if (error instanceof SandboxHttpError) {
            throw error;
        }
        return undefined;
    }
}

// Revokes one device's desktop-sync key without touching others' enrollment. Drops it from
// authorized_keys; the device notices on its next poll and stops mirroring itself.
export async function revokeSyncDevice(machine: string): Promise<void> {
    await sandboxRaw(`DELETE /system/authorized-key/{machine}`, { params: { machine } });
}

// (2026-10-15) Withdraws a device key no card holds: the hosts door's own revoke, which drops the enrollment and any socket
// still on it. Maintainer and up at the daemon, as revoking any device's access is. A refusal throws.
export async function withdrawDeviceKey(id: string): Promise<void> {
    await sandboxRaw(`DELETE /system/hosts/{id}`, { params: { id } });
}

// The connected, online device running a given sandbox slug, if any. The rule itself is the contract's
// (`hostRunningSandbox`), shared with the daemon so a button here and a turn's own reasoning cannot disagree
// about which machine is reachable. Shares the Devices query without polling it itself.
export function useHostRunning(slug: () => string | undefined): ComputedRef<string | undefined> {
    const { devices } = useDevices({ poll: false });
    return computed(() => hostRunningSandbox(devices.value, slug()));
}

// The same question for a command written for a PATH out there — the dev checkout, the log beside it — where the one
// above answers for the container alone. A PC's Windows side and the distro on it report the same containers, so only
// the path picks between their doors; the daemon reads the same rule and sends the crossing with the command, so a PC
// connected on one side only still gets a button rather than a printed command.
export function useHostHolding(slug: () => string | undefined, path: () => string | undefined): ComputedRef<string | undefined> {
    const { devices } = useDevices({ poll: false });
    return computed(() => hostHoldingPath(devices.value, slug(), path()));
}

// Reads /system/sync (useSyncStatus), not /system/devices, to avoid polling every laptop just to draw a badge.
export function useSyncHealth(): {
    stoppedOn: ComputedRef<string[]>;
    heldPorts: ComputedRef<number[]>;
    syncOffered: ComputedRef<boolean>;
    filesUnsynced: ComputedRef<boolean>;
} {
    const { status } = useSyncStatus();
    const machines = computed(() => status.value?.machines ?? []);
    return {
        // Whether offering desktop sync is honest here at all; a daemon that cannot say is taken as "no offer".
        syncOffered: computed(() => status.value?.available === true),
        // No machine holds a copy of this sandbox's files. Read strictly off `false`: an unread status and a daemon
        // that cannot answer both mean "do not claim there is no copy".
        filesUnsynced: computed(() => status.value?.syncing === false),
        // Machines whose sync watcher has stopped, though other signals still read healthy.
        stoppedOn: computed(() => machines.value.filter((report) => !report.agent.running).map((report) => report.hostname)),
        // ONLY the ports another paired sandbox took, and deliberately not every port that missed localhost. The
        // other outcomes are a machine working correctly and staying that way — a foreign program holding the
        // number, or somebody telling this device to leave it alone — and counting those here is what put a
        // standing badge on the tab of a fleet with nothing wrong with it. This one is ours, it has a remedy on
        // the Devices tab (stop the sandbox holding the port), and it is an event: something changed to cause it.
        heldPorts: computed(() => [
            ...new Set(machines.value.flatMap((report) => report.ports.filter((port) => port.state === `held-by-sandbox`).map((port) => port.port))),
        ]),
    };
}
