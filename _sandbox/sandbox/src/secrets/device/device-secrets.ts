import {
    DEVICE_FEATURE_KEYRING,
    deviceSupports,
    type KeyringRefusalCode,
    normalizeHostPattern,
    SECRET_HOSTS_MAX,
    type SecretHostGuard,
    type SecretInventoryEntry,
} from "@intentic/sandbox-contract";
import type { HostHub } from "../../hosts/host-peer.js";
import { opt } from "../../opt.js";
import { onRuntimeChange } from "../../seams/runtime-feed.js";
import type { NamedSecret } from "../secret-registry.js";
import type { DevicePointer, KeyringDevices, KeyringLinkRunner, KeyringLogger } from "./keyring-link.js";
import type { ReleasedDeviceValues } from "./keyring-stores.js";
import type { KeyringSync, KeyringSyncDevices } from "./keyring-sync.js";

// Where the keyrings' pointers meet the rest of the secrets slice: which device-held names a reference resolves through
// (none a sandbox store holds under the same name: the sandbox's own wins, said once in the log), the host guard each
// carries from its keyring, the words an agent reads when a computer will not hand a value over, and the clock that
// reads every keyring when its computer connects and every minute after.

// The stores a person or a connection fills on this sandbox: a name one of them holds is the sandbox's, whatever a
// keyring shares under it. A keyring's copy is the keyring's entry, kept here, and lists as the keyring's.
const SANDBOX_SOURCES: ReadonlySet<NamedSecret["source"]> = new Set(["env", "sandbox", "generated", "capability"]);
export const sandboxHeld = (secret: Pick<NamedSecret, "source">): boolean => SANDBOX_SOURCES.has(secret.source);

const REFRESH_EVERY_MS = 60_000;
// The mailbox goes round every fifth refresh: five minutes.
const EXCHANGE_EVERY_TICKS = 5;

// The owner's computers that can answer a keyring call now, out of the device hub.
export const keyringDevicesOf = (hub: () => Pick<HostHub, "connected" | "client" | "state">): KeyringDevices & KeyringSyncDevices => {
    const ready = (machine: string): boolean => deviceSupports(hub().state(machine).facts, DEVICE_FEATURE_KEYRING);
    return {
        ready: () => hub().connected().filter(ready),
        client: (machine) => (ready(machine) ? hub().client(machine) : undefined),
    };
};

// One device-held secret as the Secrets view lists it: where it lives and how it is shared, never a value, and never
// revealable here, since this sandbox holds none (or, for a copy, holds the keyring's entry, which is that computer's).
export const deviceInventoryEntry = ({ machine, pointer, online, locked }: DevicePointer): SecretInventoryEntry => ({
    key: pointer.name,
    kind: "device",
    status: "set",
    requiredBy: [],
    storedAt: `in the keyring on ${machine}`,
    revealable: false,
    device: { machine, mode: pointer.mode, online, ...opt("locked", locked), source: pointer.source },
    // The keyring's own lists, in force at every use (the host guard gate reads them first) and changed on that computer.
    ...opt("hosts", pointer.hosts.length === 0 ? undefined : { guard: true, list: [...pointer.hosts], source: "keyring" as const }),
    programs: { programs: [...pointer.programs], packages: [...pointer.packages], anyField: pointer.anyField, source: "keyring" },
});

export interface DeviceSecretsDeps {
    readonly link: KeyringLinkRunner;
    readonly sync: Pick<KeyringSync, "exchange">;
    readonly released: Pick<ReleasedDeviceValues, "reset">;
    readonly registry: () => Promise<readonly NamedSecret[]>;
    readonly devices: () => Pick<KeyringDevices, "ready">;
    readonly logger: KeyringLogger;
}

export interface DeviceUse {
    readonly name: string;
    readonly lane: "shell" | "code" | "browser" | "desktop";
    readonly detail: string;
    readonly conversationId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
}

export interface DeviceSecretsService {
    // The pointers a reference resolves through: one per name, none a sandbox store answers to.
    readonly held: () => Promise<readonly DevicePointer[]>;
    // The pointers the Secrets view lists: one per name the sandbox's own stores do not hold, `copy` ones included.
    readonly listed: () => Promise<readonly DevicePointer[]>;
    // Each held name's keyring hosts as a host guard that is on: read by the host-guard gate before the owner's own, so a
    // device-held value goes unasked only where its keyring says.
    readonly guards: () => Promise<readonly SecretHostGuard[]>;
    // One value for one use, asked of its computer now, or the refusal an agent reads.
    readonly fetch: (use: DeviceUse) => Promise<{ readonly value: string } | { readonly refusal: string }>;
    // Starts the reading; answers its stop.
    readonly start: () => () => void;
}

// One pointer per name: a computer that answers now before one that does not, then the most recently changed entry.
const onePerName = (pointers: readonly DevicePointer[]): DevicePointer[] => {
    const byName = new Map<string, DevicePointer>();
    for (const entry of pointers) {
        const held = byName.get(entry.pointer.name);
        const better =
            held === undefined || Number(entry.online) > Number(held.online) || (entry.online === held.online && entry.pointer.updatedAt > held.pointer.updatedAt);
        if (better) {
            byName.set(entry.pointer.name, entry);
        }
    }
    return [...byName.values()];
};

// What a keyring's refusal leaves the agent to do, by its code.
const NEXT_STEP: ReadonlyMap<KeyringRefusalCode, string> = new Map<KeyringRefusalCode, string>([
    ["declined", "The person at that computer said no: do not retry, and do not look for another way to get it."],
    ["locked", "Ask the owner to unlock the keyring there, then run it again."],
    ["busy", "Another prompt is open there: run it again in a moment."],
    ["unavailable", "Run it again once the computer is reachable, or carry on without it and say what you left undone."],
]);

export const keyringNextStep = (code: KeyringRefusalCode): string =>
    NEXT_STEP.get(code) ?? "It was not used: carry on without it, and say what you left undone.";

export const createDeviceSecrets = (deps: DeviceSecretsDeps): DeviceSecretsService => {
    // Names a sandbox store and a keyring both answer to, said in the log the first time only.
    const shadowed = new Set<string>();
    const read = async (): Promise<{ readonly registry: readonly NamedSecret[]; readonly pointers: readonly DevicePointer[] }> => {
        const [registry, pointers] = await Promise.all([deps.registry(), deps.link.pointers()]);
        const ours = new Set(registry.filter(sandboxHeld).map((secret) => secret.name));
        for (const { machine, pointer } of pointers) {
            if (ours.has(pointer.name) && !shadowed.has(pointer.name)) {
                shadowed.add(pointer.name);
                deps.logger.warn({ secret: pointer.name, machine }, "keyring: a sandbox secret has the same name as an entry a keyring shares; the sandbox's own is the one used");
            }
        }
        return { registry, pointers };
    };
    const held = async (): Promise<readonly DevicePointer[]> => {
        const { registry, pointers } = await read();
        const resolvable = new Set(registry.filter((secret) => secret.source !== "device").map((secret) => secret.name));
        return onePerName(pointers.filter((entry) => !resolvable.has(entry.pointer.name)));
    };
    const listed = async (): Promise<readonly DevicePointer[]> => {
        const { registry, pointers } = await read();
        const ours = new Set(registry.filter(sandboxHeld).map((secret) => secret.name));
        return onePerName(pointers.filter((entry) => !ours.has(entry.pointer.name)));
    };
    return {
        held,
        listed,
        // The keyring's own list, changed on that computer and never here; a host the sandbox's patterns refuse is left
        // off, which only asks more often.
        guards: async () =>
            (await held()).map(({ pointer }) => ({
                subject: pointer.name,
                kind: "secret" as const,
                guard: true,
                hosts: pointer.hosts.flatMap((host) => normalizeHostPattern(host) ?? []).slice(0, SECRET_HOSTS_MAX),
                source: "keyring" as const,
            })),
        fetch: async ({ name, lane, detail, conversationId, signal }) => {
            const entry = (await held()).find((candidate) => candidate.pointer.name === name);
            if (entry === undefined) {
                return { refusal: `"${name}" is no longer shared with this sandbox by any of the owner's keyrings, so it was not used.` };
            }
            const released = await deps.link.release({
                machine: entry.machine,
                secret: name,
                lane,
                detail,
                ...opt("conversationId", conversationId),
                ...opt("signal", signal),
            });
            if (released.ok) {
                return { value: released.value };
            }
            return { refusal: `"${name}" is kept in the keyring on ${entry.machine}, which did not hand it over: ${released.refusal} ${keyringNextStep(released.code)}` };
        },
        start: () => {
            const warn = (what: string) => (error: Error) => deps.logger.warn({ err: error }, `keyring: ${what}`);
            // What an earlier process left for the terminal's masking goes before anything is released in this one.
            void deps.released.reset().catch(warn("the released values file could not be reset"));
            let seen: ReadonlySet<string> = new Set();
            const look = (): void => {
                const ready = new Set(deps.devices().ready());
                for (const machine of ready) {
                    if (!seen.has(machine)) {
                        void deps.link
                            .arrived(machine)
                            .then(() => deps.sync.exchange(machine))
                            .catch(warn("a computer that connected could not be read"));
                    }
                }
                seen = ready;
            };
            const unsubscribe = onRuntimeChange((domains) => {
                if (domains.includes("hosts")) {
                    look();
                }
            });
            let ticks = 0;
            const timer = setInterval(() => {
                look();
                void deps.link.refresh().catch(warn("the keyrings could not be read"));
                ticks += 1;
                if (ticks % EXCHANGE_EVERY_TICKS === 0) {
                    void deps.sync.exchange().catch(warn("the sync mailbox did not go round"));
                }
            }, REFRESH_EVERY_MS);
            timer.unref();
            look();
            return () => {
                unsubscribe();
                clearInterval(timer);
            };
        },
    };
};
