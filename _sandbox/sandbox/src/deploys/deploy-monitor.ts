import { errorMessage } from "@intentic/base/errors";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DeployRecord, HostStats, StackHealthState } from "@intentic/sandbox-contract/schemas/deploys";
import type { DeviceStack, DeviceStacks } from "@intentic/sandbox-contract/schemas/device-stacks";
import { DEVICE_FEATURE_HOST_STATS, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import type { Logger } from "pino";
import { deviceHostStats, deviceStacks, type StackServices } from "../hosts/stacks/device-stacks.js";
import { type HostLowEvent, hostLowMessageOf, type StackStateEvent, stackStateMessageOf } from "./deploy-events.js";
import { type DeclaredStack, workspaceManifests } from "./deploy-manifests.js";
import { resolveDevice } from "./deploy-run.js";
import type { DeployWatchStore, WatchedHost, WatchedStack } from "./deploy-watch-store.js";
import type { DeploysEngine } from "./deploys-engine.js";

/* HOW EACH MANAGED STACK AND ITS SERVER ARE DOING, READ WITHOUT A TURN (deploy-watch.ts runs it every minute, and the
   servers' fill every five): one `list_stacks` per connected computer that hosts a managed environment, never one per
   stack, and each stack's state set on the engine for the board (running, unhealthy, restarting, stopped, missing, or
   unreachable while its computer is not connected or does not answer).

   The owner hears of a stack (a `deploys` listener event) when a deploy from here once came up on it and it then reads
   unhealthy, restarting, stopped or missing twice in a row (`stack_unhealthy`), and again once it reads running twice in
   a row after that (`stack_recovered`). Not while the engine deploys it (a deploy's own end is its event, and the reads
   start counting again after it), not for a stack another sandbox owns there, and not for an unreachable one, which
   says nothing about the stack: its computer's card says it is offline. What the owner was last told is kept
   (deploy-watch-store.ts), so a restart tells nothing twice.

   A server advertising `host-stats` is low on disk while any disk it reports has less than 10% or 5 GiB free, and low on
   memory below 5% available (`host_low_disk`, `host_low_memory`, channel `device:<id>`), told once per episode: it is
   low again only once it has been back above 12% and 6 GiB (8% for memory), so a disk hovering at the line is told
   once, not every five minutes. */

export interface MonitorDeps {
    readonly root: string;
    readonly engine: Pick<DeploysEngine, "records" | "setStackState">;
    readonly device: StackServices;
    readonly deviceCards: () => Promise<readonly Capability[]>;
    readonly store: DeployWatchStore;
    readonly dispatch: (message: ListenerMessage) => Promise<void>;
    readonly logger: Pick<Logger, "warn">;
    readonly now: () => number;
}

// A compose project's state from its containers. A container that exited 0 beside running ones is a one-shot that
// finished (a migration); any other one stopped beside them is the stack broken.
export const stackHealthOf = (found: DeviceStack | undefined): StackHealthState => {
    if (found === undefined) {
        return "missing";
    }
    const { services } = found;
    if (services.some((service) => service.state === "restarting")) {
        return "restarting";
    }
    if (!services.some((service) => service.state === "running")) {
        return "stopped";
    }
    const finished = (service: (typeof services)[number]): boolean => service.state === "exited" && service.status.startsWith('Exited (0)');
    const broken = services.some((service) => service.health === "unhealthy" || (service.state !== "running" && !finished(service)));
    return broken ? "unhealthy" : "running";
};

const BAD: ReadonlySet<StackHealthState> = new Set(["unhealthy", "restarting", "stopped", "missing"]);

// How many reads in a row a state must hold before the owner is told of it.
const READS_TO_TELL = 2;

interface StackRead {
    readonly declared: DeclaredStack;
    readonly state: StackHealthState;
    readonly ownedElsewhere: boolean;
}

// The stack's entry after one more read, and what to tell the owner of it, if anything.
interface Stepped {
    readonly entry: WatchedStack;
    readonly event?: StackStateEvent | undefined;
}

const stepped = (held: WatchedStack | undefined, read: StackRead, records: readonly DeployRecord[], at: string): Stepped => {
    const { repo, spec } = read.declared;
    const own = records.filter((record) => record.repo === repo && record.stack === spec.name);
    const deploying = own.some((record) => record.outcome === "queued" || record.outcome === "running");
    const same = held?.state === read.state;
    const entry: WatchedStack = {
        repo,
        stack: spec.name,
        state: read.state,
        since: same ? held.since : at,
        // A deploy changes the stack under the read: the count starts again after it.
        reads: deploying ? 0 : same ? held.reads + 1 : 1,
        told: held?.told ?? "ok",
    };
    if (deploying || read.ownedElsewhere || entry.reads < READS_TO_TELL) {
        return { entry };
    }
    const base = { repo, stack: spec.name, device: spec.device, state: read.state, since: entry.since };
    const cameUp = own.some((record) => record.outcome === "succeeded");
    if (BAD.has(read.state) && entry.told === "ok" && cameUp) {
        return { entry: { ...entry, told: "bad" }, event: { ...base, type: "stack_unhealthy" } };
    }
    if (read.state === "running" && entry.told === "bad") {
        return { entry: { ...entry, told: "ok" }, event: { ...base, type: "stack_recovered" } };
    }
    return { entry };
};

// Each managed environment by the connection key of the computer it runs on; one naming no paired computer is left
// out, since there is nothing to read (the board says why).
const placed = async (deps: Pick<MonitorDeps, "root" | "deviceCards">): Promise<Map<string, DeclaredStack[]>> => {
    const [{ stacks }, cards] = await Promise.all([workspaceManifests(deps.root), deps.deviceCards()]);
    const byDevice = new Map<string, DeclaredStack[]>();
    for (const declared of stacks) {
        const id = resolveDevice(declared.spec.device, cards);
        if (id !== undefined) {
            byDevice.set(id, [...(byDevice.get(id) ?? []), declared]);
        }
    }
    return byDevice;
};

// ---- servers ----------------------------------------------------------------------------------------------------

const GIB = 1024 ** 3;
type Disk = HostStats["disks"][number];
const diskLow = (disk: Disk): boolean => disk.freeBytes < disk.totalBytes * 0.1 || disk.freeBytes < 5 * GIB;
const diskClear = (disk: Disk): boolean => disk.freeBytes >= disk.totalBytes * 0.12 && disk.freeBytes >= 6 * GIB;
const memoryLow = (memory: HostStats["memory"]): boolean => memory.availableBytes < memory.totalBytes * 0.05;
const memoryClear = (memory: HostStats["memory"]): boolean => memory.availableBytes >= memory.totalBytes * 0.08;

// What is low on the server after this reading, and what went low with it. Two roles on one volume (Docker's data root
// and the stacks folder often share it) read the same total and free bytes: told once, by the first.
export interface HostStep {
    readonly low: string[];
    readonly events: HostLowEvent[];
}

export const hostStepped = (device: string, held: readonly string[], stats: HostStats): HostStep => {
    const low = new Set(held);
    const events: HostLowEvent[] = [];
    const seen = new Set<string>();
    const measured: { readonly key: string; readonly isLow: boolean; readonly isClear: boolean; readonly event: HostLowEvent }[] = [];
    for (const disk of stats.disks.filter((candidate) => candidate.totalBytes > 0)) {
        const volume = `${disk.totalBytes}:${disk.freeBytes}`;
        if (seen.has(volume)) {
            continue;
        }
        seen.add(volume);
        const event: HostLowEvent = { type: "host_low_disk", device, what: disk.path, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes };
        measured.push({ key: `disk:${disk.path}`, isLow: diskLow(disk), isClear: diskClear(disk), event });
    }
    if (stats.memory.totalBytes > 0) {
        const event: HostLowEvent = { type: "host_low_memory", device, what: "memory", freeBytes: stats.memory.availableBytes, totalBytes: stats.memory.totalBytes };
        measured.push({ key: "memory", isLow: memoryLow(stats.memory), isClear: memoryClear(stats.memory), event });
    }
    for (const { key, isLow, isClear, event } of measured) {
        if (isLow && !low.has(key)) {
            low.add(key);
            events.push(event);
        } else if (isClear) {
            low.delete(key);
        }
    }
    return { low: [...low].sort(), events };
};

export const createMonitor = (deps: MonitorDeps) => {
    const tell = async (message: ListenerMessage): Promise<void> => {
        await deps.dispatch(message).catch((error: Error) => deps.logger.warn({ err: error, type: message.type }, "deploys: a monitor event could not be dispatched"));
    };

    // What the last daemon read, on the board at once rather than `unknown` until the first read.
    const restore = async (): Promise<void> => {
        for (const held of (await deps.store.read()).stacks) {
            deps.engine.setStackState(held.repo, held.stack, held.state, held.since);
        }
    };

    // The computer's stack list, or undefined when it is not connected or did not answer.
    const listed = async (id: string): Promise<DeviceStacks | undefined> => {
        if (!deps.device.hostHub.online(id)) {
            return undefined;
        }
        try {
            return await deviceStacks(deps.device, id);
        } catch (error) {
            deps.logger.warn({ err: error, device: id }, `deploys: the monitor could not read the stacks on a computer: ${errorMessage(error)}`);
            return undefined;
        }
    };

    // One pass over every managed stack.
    const readStacks = async (): Promise<void> => {
        const reads: StackRead[] = [];
        for (const [id, stacks] of await placed(deps)) {
            const list = await listed(id);
            for (const declared of stacks) {
                const found = list?.stacks.find((stack) => stack.name === declared.spec.name);
                const ownedElsewhere = found?.owner !== undefined && !found.owner.you;
                reads.push({ declared, state: list === undefined ? "unreachable" : stackHealthOf(found), ownedElsewhere });
            }
        }
        const records = await deps.engine.records();
        const at = new Date(deps.now()).toISOString();
        const events: StackStateEvent[] = [];
        const entries: WatchedStack[] = [];
        await deps.store.update((current) => {
            entries.length = 0;
            events.length = 0;
            for (const read of reads) {
                const held = current.stacks.find((entry) => entry.repo === read.declared.repo && entry.stack === read.declared.spec.name);
                const { entry, event } = stepped(held, read, records, at);
                entries.push(entry);
                events.push(...(event === undefined ? [] : [event]));
            }
            // Unchanged by reference when nothing moved, which skips the write: most minutes nothing does.
            return JSON.stringify(entries) === JSON.stringify(current.stacks) ? current : { ...current, stacks: [...entries] };
        });
        for (const [index, entry] of entries.entries()) {
            deps.engine.setStackState(entry.repo, entry.stack, entry.state, entry.since, reads[index]?.ownedElsewhere);
        }
        for (const event of events) {
            await tell(stackStateMessageOf(event, new Date(deps.now())));
        }
    };

    // One pass over every server hosting a managed stack whose agent can say how full it is.
    const readHosts = async (): Promise<void> => {
        const readings: { readonly device: string; readonly stats: HostStats }[] = [];
        for (const id of (await placed(deps)).keys()) {
            if (!deps.device.hostHub.online(id) || !deviceSupports(deps.device.hostHub.state(id).facts, DEVICE_FEATURE_HOST_STATS)) {
                continue;
            }
            try {
                readings.push({ device: id, stats: await deviceHostStats(deps.device, id) });
            } catch (error) {
                deps.logger.warn({ err: error, device: id }, `deploys: the monitor could not read how full a computer is: ${errorMessage(error)}`);
            }
        }
        const events: HostLowEvent[] = [];
        await deps.store.update((current) => {
            events.length = 0;
            const hosts: WatchedHost[] = current.hosts.filter((host) => !readings.some((reading) => reading.device === host.device));
            for (const { device, stats } of readings) {
                const stepping = hostStepped(device, current.hosts.find((host) => host.device === device)?.low ?? [], stats);
                hosts.push({ device, low: stepping.low });
                events.push(...stepping.events);
            }
            return JSON.stringify(hosts) === JSON.stringify(current.hosts) ? current : { ...current, hosts };
        });
        for (const event of events) {
            await tell(hostLowMessageOf(event, new Date(deps.now())));
        }
    };

    return { restore, readStacks, readHosts };
};
