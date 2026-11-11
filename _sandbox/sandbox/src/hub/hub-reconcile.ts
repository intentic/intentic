import { createHash } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { type ConnectionEnvelope, type HubTarget, isHubEntryName } from "@intentic/sandbox-contract/schemas/connection-hub";
import { collidesWithReservedServer } from "@intentic/sandbox-contract/policy/reserved-servers";
import type { Logger } from "pino";
import { capabilityCtx } from "../capabilities/capability.js";
import { applyAndStore, convergeAfterConnectionChange, uninstallConnection } from "./connection-install.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { copyAccountIn, forgetAccount } from "./account-copies.js";
import { parseEnvelope } from "./hub-items.js";
import type { HubFile, HubSeenRecord, HubStore } from "./hub-store.js";

// KEEPING WHAT THE HUB MADE HERE IN STEP WITH THE ENTRIES SHARED HERE (schemas/connection-hub.ts): after every keyring
// read, each hub entry shared here is made into what it describes, made again when its value changes, and taken away
// once the computer stops sharing it. Only what the hub made is ever taken away: a connection this sandbox saved was its
// own before the hub held it, and stays.

export interface HubDeps {
    readonly store: HubStore;
    readonly logger: Logger;
    readonly whole: () => Services;
}

export const hashOf = (value: string): string => createHash("sha256").update(value).digest("hex");

export const describeTarget = (target: HubTarget): string => (target.type === "card" ? target.id : `${target.provider}/${target.id}`);

export const auditHub = (deps: HubDeps, action: string, target: string, details: Readonly<Record<string, string>>): void =>
    deps.whole().audit.record({ actor: { kind: "system", reason: "connections hub" }, action, target, details: { ...details } });

const ID_MAX = 60;

// The card's id where it was saved, else that id numbered past the ones taken (or reserved for the daemon's own tools).
const freeCardId = (wanted: string, kind: Capability["kind"], taken: ReadonlySet<string>): string => {
    const base = wanted.replace(/[^a-zA-Z0-9_-]/gu, "-").replace(/^[^a-zA-Z0-9]+/u, "").slice(0, ID_MAX - 4) || "connection";
    const free = (id: string): boolean => !taken.has(id) && !collidesWithReservedServer(kind, id);
    if (free(base)) {
        return base;
    }
    for (let n = 2; n < 1000; n += 1) {
        const id = `${base}-${n}`;
        if (free(id)) {
            return id;
        }
    }
    throw new Error(`no free id near "${base}"`);
};

const upsertSeen = (file: HubFile, record: HubSeenRecord): HubFile => ({ ...file, seen: [...file.seen.filter((seen) => seen.entry !== record.entry), record] });

// Makes one envelope into a card or account here, over what an earlier copy of the same entry made.
const make = async (services: Services, envelope: ConnectionEnvelope, before: HubTarget | undefined): Promise<HubTarget> => {
    const { item } = envelope;
    if (item.type === "account") {
        const into = before?.type === "account" && before.provider === item.provider ? before.id : undefined;
        return { type: "account", provider: item.provider, id: await copyAccountIn(services, item.provider, item.account, into) };
    }
    const held = await services.capabilities.list();
    const id = before?.type === "card" ? before.id : freeCardId(item.id, item.kind, new Set(held.map((capability) => capability.id)));
    const entry = CapabilitySchema.parse({ id, kind: item.kind, config: item.config });
    for await (const frame of applyAndStore(services, capabilityCtx(services), entry, `connection ${id} from your computer`)) {
        void frame;
    }
    await convergeAfterConnectionChange(services, entry.kind);
    return { type: "card", id };
};

const unmake = async (services: Services, target: HubTarget): Promise<void> => {
    if (target.type === "account") {
        await forgetAccount(services, target.provider, target.id);
        return;
    }
    const capability = await services.capabilities.get(target.id);
    if (capability !== undefined) {
        await uninstallConnection(services, capabilityCtx(services), capability, `removed connection ${target.id}, no longer shared from your computer`);
    }
};

// One entry shared here: made into what it describes, unless its value is the one already made.
const settleEntry = async (deps: HubDeps, file: HubFile, name: string, value: string): Promise<HubFile> => {
    const hash = hashOf(value);
    const seen = file.seen.find((record) => record.entry === name);
    if (seen !== undefined && seen.hash === hash) {
        return file;
    }
    const services = deps.whole();
    const machine = (await services.keyringLink.pointer(name))?.machine;
    const envelope = parseEnvelope(value);
    if (envelope === undefined) {
        return upsertSeen(file, { entry: name, ...opt("machine", machine), hash, made: false, failure: "It is not a connection this sandbox can read.", at: Date.now() });
    }
    try {
        // Over what the entry made before, or over the connection this sandbox saved as it: never a second copy beside it.
        const target = await make(services, envelope, seen?.target ?? file.saved.find((saved) => saved.entry === name)?.target);
        // A connection this sandbox saved itself comes back shared: it stays this sandbox's own.
        const made = seen?.made ?? !file.saved.some((saved) => saved.entry === name);
        auditHub(deps, "hub.take", name, { made: describeTarget(target), ...opt("machine", machine) });
        deps.logger.info({ entry: name, machine, target }, "connections hub: an entry shared here was made into a connection");
        return upsertSeen(file, { entry: name, ...opt("machine", machine), hash, target, made, at: Date.now() });
    } catch (error) {
        deps.logger.warn({ err: error, entry: name, machine }, "connections hub: an entry shared here could not be made into a connection");
        return upsertSeen(file, {
            entry: name,
            ...opt("machine", machine),
            hash,
            ...opt("target", seen?.target),
            made: seen?.made ?? false,
            failure: errorMessage(error),
            at: Date.now(),
        });
    }
};

// One entry no longer shared here: what the hub made of it goes with it.
const dropEntry = async (deps: HubDeps, file: HubFile, seen: HubSeenRecord): Promise<HubFile> => {
    if (seen.made && seen.target !== undefined) {
        try {
            await unmake(deps.whole(), seen.target);
            auditHub(deps, "hub.drop", seen.entry, { removed: describeTarget(seen.target) });
        } catch (error) {
            deps.logger.warn({ err: error, entry: seen.entry }, "connections hub: what an entry no longer shared here made could not be removed; the next pass tries again");
            return file;
        }
    }
    return { saved: file.saved.filter((saved) => saved.entry !== seen.entry), seen: file.seen.filter((record) => record.entry !== seen.entry) };
};

const pass = async (deps: HubDeps): Promise<void> => {
    const copies = Object.entries(await deps.whole().keyringCopies.all()).filter(([name]) => isHubEntryName(name));
    const shared = new Set(copies.map(([name]) => name));
    const before = await deps.store.read();
    let file = before;
    for (const [name, value] of copies) {
        file = await settleEntry(deps, file, name, value);
    }
    for (const seen of file.seen.filter((record) => !shared.has(record.entry))) {
        file = await dropEntry(deps, file, seen);
    }
    if (file !== before) {
        const settled = file;
        await deps.store.update(() => settled);
        publishRuntimeChange("capabilities");
    }
};

/** One reconcile at a time: a call while one runs asks for one more pass after it, and waits for that. */
export const createHubReconciler = (deps: HubDeps): (() => Promise<void>) => {
    let running: Promise<void> | undefined;
    let again = false;
    return async () => {
        if (running !== undefined) {
            again = true;
            return await running;
        }
        running = (async () => {
            do {
                again = false;
                await pass(deps);
            } while (again);
        })().finally(() => {
            running = undefined;
        });
        return await running;
    };
};
