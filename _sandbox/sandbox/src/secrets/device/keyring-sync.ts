import { type deviceContract, type KeyringSyncItem, KeyringSyncItemSchema, type KeyringSyncState } from "@intentic/sandbox-contract";
import { keyFingerprint } from "@intentic/sandbox-contract/keyring-seal";
import type { ContractRouterClient } from "@orpc/contract";
import { ASKING_TIMEOUT_MS, keyringCodeOf, type KeyringLogger } from "./keyring-link.js";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// Two of the owner's keyrings kept in step through this sandbox (schemas/keyring.ts "sync"): each change a keyring makes
// is sealed to its paired keyring's sync key and left here, in a MAILBOX this sandbox carries without a key that opens
// anything in it. Items are collected from every keyring's outbox when it connects and every five minutes, and handed to
// the keyring whose sync key they are sealed to whenever that one is connected. Only the newest item from one keyring to
// another matters (each carries the sender's whole set at its revision), so an older one is dropped when a newer
// arrives, and the mailbox keeps at most 256, dropping the oldest.

export type KeyringSyncClient = Pick<
    ContractRouterClient<typeof deviceContract>,
    "keyringSyncState" | "keyringSyncPair" | "keyringSyncOutbox" | "keyringSyncDeliver"
>;

export interface KeyringSyncDevices {
    readonly ready: () => readonly string[];
    readonly client: (machine: string) => KeyringSyncClient | undefined;
}

export const MAILBOX_CAP = 256;
// What one delivery may carry (KeyringSyncDeliverSchema).
const DELIVER_MAX = 64;
const SYNC_TIMEOUT_MS = 20_000;

// Oldest first, as collected.
export const keyringSyncMailboxDocument = defineDocument({
    root: "auth",
    path: "keyring-sync-mailbox.json",
    schema: z.object({ items: z.array(KeyringSyncItemSchema) }),
});
type Mailbox = z.output<typeof keyringSyncMailboxDocument.schema>;

export interface KeyringSyncDeps {
    readonly devices: () => KeyringSyncDevices;
    readonly mailboxPath: string;
    readonly logger: KeyringLogger;
}

// A pairing one of the two keyrings refused, in its own words.
export class KeyringPairRefused extends Error {
    override name = "KeyringPairRefused";
}

export interface KeyringSync {
    // A keyring's sync key and the computers it is paired with, as last heard in this process.
    readonly syncOf: (machine: string) => { readonly key: string; readonly peers: readonly string[] } | undefined;
    // Collects what one connected keyring (or every one) has to send and hands each its own.
    readonly exchange: (machine?: string) => Promise<void>;
    // Asks both keyrings to pair with each other; answers both sync-key fingerprints as their prompts showed them.
    readonly pair: (a: string, b: string, signal?: AbortSignal) => Promise<{ readonly a: string; readonly b: string }>;
    readonly mailbox: () => Promise<readonly KeyringSyncItem[]>;
}

// One item as the mailbox tells it apart: a sender's set for one recipient at one revision.
const itemKey = (item: KeyringSyncItem): string => `${item.from}\u0000${item.to}\u0000${String(item.revision)}`;

// The newest item per sender and recipient, then the newest 256, oldest first.
export const intoMailbox = (current: readonly KeyringSyncItem[], arrived: readonly KeyringSyncItem[]): KeyringSyncItem[] => {
    const newest = new Map<string, KeyringSyncItem>();
    for (const item of [...current, ...arrived]) {
        const key = `${item.from}\u0000${item.to}`;
        const held = newest.get(key);
        if (held === undefined || item.revision > held.revision) {
            newest.delete(key);
            newest.set(key, item);
        }
    }
    return [...newest.values()].slice(-MAILBOX_CAP);
};

export const createKeyringSync = (deps: KeyringSyncDeps): KeyringSync => {
    const file = openDocument(keyringSyncMailboxDocument, deps.mailboxPath, { fallback: (): Mailbox => ({ items: [] }), mode: 0o600 });
    const states = new Map<string, KeyringSyncState>();

    const learn = async (machine: string, client: KeyringSyncClient): Promise<KeyringSyncState> => {
        const state = await client.keyringSyncState(undefined, { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
        states.set(machine, state);
        return state;
    };

    const collect = async (machine: string, client: KeyringSyncClient): Promise<void> => {
        const { items } = await client.keyringSyncOutbox(undefined, { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
        if (items.length > 0) {
            await file.update((current) => ({ items: intoMailbox(current.items, items) }));
        }
    };

    // Everything sealed to this keyring, handed over; what it took or refused alike leaves the mailbox, since an item it
    // could not open now never will.
    const deliver = async (machine: string, client: KeyringSyncClient, state: KeyringSyncState): Promise<void> => {
        const owed = (await file.read()).items.filter((item) => item.to === state.key).slice(0, DELIVER_MAX);
        if (owed.length === 0) {
            return;
        }
        const { accepted } = await client.keyringSyncDeliver({ items: owed }, { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
        if (accepted < owed.length) {
            deps.logger.warn({ machine, accepted, sent: owed.length }, "keyring sync: a keyring took fewer items than it was handed; the rest were not for it");
        }
        const sent = new Set(owed.map(itemKey));
        await file.update((current) => ({ items: current.items.filter((item) => !sent.has(itemKey(item))) }));
    };

    const exchangeOne = async (machine: string): Promise<void> => {
        const client = deps.devices().client(machine);
        if (client === undefined) {
            states.delete(machine);
            return;
        }
        const exchanged = async (): Promise<void> => {
            const state = await learn(machine, client);
            await collect(machine, client);
            await deliver(machine, client, state);
        };
        await exchanged().catch((error: Error) => {
            // A keyring that is locked or not running says so at every exchange; it is tried again later either way.
            if (keyringCodeOf(error) === undefined) {
                deps.logger.warn({ err: error, machine }, "keyring sync: the exchange with this keyring did not finish; it is tried again later");
            }
        });
    };

    const pairOne = async (machine: string, client: KeyringSyncClient, peer: { readonly device: string; readonly key: string }, signal?: AbortSignal): Promise<void> => {
        const answer = await client.keyringSyncPair(
            { peer, self: machine },
            { signal: signal === undefined ? AbortSignal.timeout(ASKING_TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(ASKING_TIMEOUT_MS), signal]) },
        );
        if (!answer.ok) {
            throw new KeyringPairRefused(`The keyring on ${machine} did not pair: ${answer.refusal}`);
        }
    };

    return {
        syncOf: (machine) => {
            const state = states.get(machine);
            return state === undefined ? undefined : { key: state.key, peers: state.peers.map((peer) => peer.device) };
        },
        exchange: async (machine) => {
            const targets = machine === undefined ? deps.devices().ready() : [machine];
            for (const target of targets) {
                await exchangeOne(target);
            }
        },
        mailbox: async () => (await file.read()).items,
        pair: async (a, b, signal) => {
            if (a === b) {
                throw new KeyringPairRefused("A keyring is paired with another computer's, not with itself.");
            }
            const clientA = deps.devices().client(a);
            const clientB = deps.devices().client(b);
            if (clientA === undefined || clientB === undefined) {
                throw new KeyringPairRefused(`${clientA === undefined ? a : b} is not connected with a keyring right now, so the two cannot be paired.`);
            }
            const [stateA, stateB] = await Promise.all([learn(a, clientA), learn(b, clientB)]);
            // Asked of both at once: a person may well be at both computers, and each prompt shows both fingerprints.
            await Promise.all([pairOne(a, clientA, { device: b, key: stateB.key }, signal), pairOne(b, clientB, { device: a, key: stateA.key }, signal)]);
            await Promise.all([learn(a, clientA), learn(b, clientB)]).catch((error: Error) =>
                deps.logger.warn({ err: error }, "keyring sync: the paired keyrings' state could not be read again"),
            );
            return { a: keyFingerprint(stateA.key), b: keyFingerprint(stateB.key) };
        },
    };
};
