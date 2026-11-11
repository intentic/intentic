import { randomBytes } from "node:crypto";
import {
    type HubSaved,
    type HubState,
    type HubTaken,
    type HubTarget,
    type HubWant,
    hubEntryName,
    hubHostOf,
    sameHubTarget,
    wantOfItem,
} from "@intentic/sandbox-contract/schemas/connection-hub";
import { contributionRegistry } from "../capabilities/contributions.js";
import { opt } from "../opt.js";
import { envelopeOf, HubRefusal, hubHoldings } from "./hub-items.js";
import { auditHub, createHubReconciler, describeTarget, hashOf, type HubDeps } from "./hub-reconcile.js";
import type { HubFile } from "./hub-store.js";

// THE CONNECTIONS HUB as this sandbox runs it (schemas/connection-hub.ts): saving sends a card or static account to a
// computer's keyring inbox; taking asks the computers for one through the keyring's own need; and after every keyring
// read the entries shared here are reconciled with what they made (hub-reconcile.ts).

export interface ConnectionHub {
    readonly state: () => Promise<HubState>;
    readonly save: (target: HubTarget, machine: string) => Promise<HubSaved>;
    readonly take: (want: HubWant, why?: string) => Promise<HubTaken>;
    // Brings what the hub made here in step with the entries shared now; one pass at a time.
    readonly reconcile: () => Promise<void>;
    // Reconciles now and after every keyring read; answers its stop.
    readonly start: () => () => void;
}

const sandboxName = (deps: HubDeps): string => deps.whole().info?.name ?? "a sandbox";

// The entry a target already went to the hub as, or came from: saving it again replaces that entry.
const entryFor = (file: HubFile, target: HubTarget): string | undefined =>
    file.saved.find((saved) => sameHubTarget(saved.target, target))?.entry ??
    file.seen.find((seen) => seen.target !== undefined && sameHubTarget(seen.target, target))?.entry;

const hubState = async (deps: HubDeps): Promise<HubState> => {
    const services = deps.whole();
    const [file, computers, connectors] = await Promise.all([deps.store.read(), services.keyringLink.computers(), contributionRegistry(services)]);
    return {
        computers: computers.map((computer) => ({ machine: computer.machine, online: computer.online, setUp: computer.setUp, ...opt("locked", computer.locked) })),
        holdings: await hubHoldings(services, connectors, file),
        failures: file.seen.flatMap((seen) => (seen.failure === undefined ? [] : [{ entry: seen.entry, ...opt("machine", seen.machine), message: seen.failure, at: seen.at }])),
    };
};

const refuseUnreadyComputer = async (deps: HubDeps, machine: string): Promise<void> => {
    const computer = (await deps.whole().keyringLink.computers()).find((candidate) => candidate.machine === machine);
    if (computer === undefined || !computer.online) {
        throw new HubRefusal(`${machine} is not connected right now, so its keyring cannot take this connection.`);
    }
    if (!computer.setUp) {
        throw new HubRefusal(`Passwords is not set up on ${machine} yet: set it up there first (intentic-machine keyring setup).`);
    }
};

const saveToHub = async (deps: HubDeps, target: HubTarget, machine: string): Promise<HubSaved> => {
    await refuseUnreadyComputer(deps, machine);
    const services = deps.whole();
    const envelope = await envelopeOf(services, await contributionRegistry(services), target, { sandbox: sandboxName(deps), at: Date.now() });
    const value = JSON.stringify(envelope);
    const file = await deps.store.read();
    const entry = entryFor(file, target) ?? hubEntryName(envelope.item, randomBytes(2).toString("hex"));
    const answer = await services.keyringLink.inbox({ machine, name: entry, value, mode: "copy", kind: "text", programs: [], hosts: [hubHostOf(wantOfItem(envelope.item))] });
    if (!answer.ok) {
        throw new HubRefusal(`${machine} did not take it: ${answer.refusal}`);
    }
    const made = file.seen.find((record) => record.entry === entry)?.made ?? false;
    await deps.store.update((current) => ({
        saved: [...current.saved.filter((saved) => !sameHubTarget(saved.target, target)), { target, entry, machine, at: Date.now(), pending: answer.pending }],
        // What was sent is what comes back shared: seen already, so it is not made a second time here.
        seen: [...current.seen.filter((record) => record.entry !== entry), { entry, machine, hash: hashOf(value), target, made, at: Date.now() }],
    }));
    auditHub(deps, "hub.save", entry, { machine, what: describeTarget(target) });
    return { entry, machine, pending: answer.pending };
};

const takeFromHub = async (deps: HubDeps, reconcile: () => Promise<void>, want: HubWant, why: string | undefined): Promise<HubTaken> => {
    const services = deps.whole();
    const answer = await services.keyringNeeds.request({
        origin: { kind: "site", host: hubHostOf(want) },
        detail: (why ?? `Use a connection you saved, in ${sandboxName(deps)}`).slice(0, 300),
        purpose: "owner",
        typeOnce: false,
    });
    if (answer.state === "pending") {
        return { outcome: "waiting", message: `Waiting for your yes in Passwords on ${answer.machine}.` };
    }
    if (answer.state !== "allowed") {
        return { outcome: "none", message: answer.message };
    }
    await services.keyringLink.refresh(answer.machine);
    await reconcile();
    const seen = (await deps.store.read()).seen.find((record) => record.entry === answer.name);
    if (seen?.failure !== undefined) {
        return { outcome: "none", message: `${answer.machine} shared it, but it could not be made here: ${seen.failure}` };
    }
    return { outcome: "taken", message: `Shared from ${answer.machine}.`, ...opt("target", seen?.target) };
};

export const createConnectionHub = (deps: HubDeps): ConnectionHub => {
    const reconcile = createHubReconciler(deps);
    return {
        state: () => hubState(deps),
        save: (target, machine) => saveToHub(deps, target, machine),
        take: (want, why) => takeFromHub(deps, reconcile, want, why),
        reconcile,
        start: () => {
            const run = (): void => {
                void reconcile().catch((error: Error) => deps.logger.warn({ err: error }, "connections hub: a pass failed; the next keyring read tries again"));
            };
            run();
            return deps.whole().keyringLink.onRefreshed(run);
        },
    };
};
