import { randomBytes } from "node:crypto";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import { tokenEquals } from "./auth.js";

// Door tokens: credentials behind the daemon's public doors, for an outside caller with no Google identity or control
// token.
// - automation POST /automations/{id}/fire
// - gate POST /workflows/{id}/gate
// - intake POST /intake/{id}/report
// Stored plaintext in the secrets class, since a maintainer must be able to re-display a taught URL; locked from the
// file API to bound exposure.
// `ensure` mints on first look and returns the same value until rotated; `rotate` invalidates a leaked URL without
// re-teaching the caller its id.

export const DOOR_KINDS = ["automation", "gate", "intake"] as const;
export type DoorKind = (typeof DOOR_KINDS)[number];

const StoredDoorsSchema = z.object({
    automation: z.record(z.string(), z.string()).default({}),
    gate: z.record(z.string(), z.string()).default({}),
    intake: z.record(z.string(), z.string()).default({}),
});
type StoredDoors = z.infer<typeof StoredDoorsSchema>;

export interface DoorTokens {
    // The door's credential, minted now if it has none. The same value every time until rotated or removed.
    readonly ensure: (kind: DoorKind, id: string) => Promise<string>;
    // The credential if the door has one; never mints. For a check that must not create a door as a side effect.
    readonly peek: (kind: DoorKind, id: string) => Promise<string | undefined>;
    // Is this what the door was issued? Constant-time; false for no credential and for the empty string.
    readonly verify: (kind: DoorKind, id: string, presented: string) => Promise<boolean>;
    // A fresh credential, the previous one retired in the same write.
    readonly rotate: (kind: DoorKind, id: string) => Promise<string>;
    // The door is gone (its automation deleted, its gate removed from the design): so is its credential.
    readonly remove: (kind: DoorKind, id: string) => Promise<void>;
}

// An intake key ships inside an app binary and shows up in crash logs, so the prefix says what it is.
// The other two only ever get pasted into a secret store and stay a bare value.
const mintFor = (kind: DoorKind): string => (kind === "intake" ? `ik_${randomBytes(18).toString("base64url")}` : randomBytes(24).toString("base64url"));

const EMPTY: StoredDoors = { automation: {}, gate: {}, intake: {} };

export const fileDoorTokens = (path: string): DoorTokens => {
    const file = jsonFile<StoredDoors>(path, { parse: objectParse(StoredDoorsSchema), fallback: () => EMPTY });
    const write = async (kind: DoorKind, id: string, token: string | undefined): Promise<void> => {
        await file.update((stored) => {
            const doors = { ...stored[kind] };
            if (token === undefined) {
                if (!(id in doors)) {
                    return stored;
                }
                delete doors[id];
            } else {
                doors[id] = token;
            }
            return { ...stored, [kind]: doors };
        });
    };
    const peek = async (kind: DoorKind, id: string): Promise<string | undefined> => (await file.read())[kind][id];
    return {
        ensure: async (kind, id) => {
            let minted: string | undefined;
            // Inside the update, so two first callers (a save and a list landing together) cannot mint two.
            await file.update((stored) => {
                const existing = stored[kind][id];
                if (existing !== undefined) {
                    minted = existing;
                    return stored;
                }
                minted = mintFor(kind);
                return { ...stored, [kind]: { ...stored[kind], [id]: minted } };
            });
            return minted as string;
        },
        peek,
        verify: async (kind, id, presented) => {
            const token = await peek(kind, id);
            return token !== undefined && presented !== "" && tokenEquals(presented, token);
        },
        rotate: async (kind, id) => {
            const token = mintFor(kind);
            await write(kind, id, token);
            return token;
        },
        remove: (kind, id) => write(kind, id, undefined),
    };
};

// The in-memory twin, for tests and for a composition with no workspace to persist into.
export const memoryDoorTokens = (): DoorTokens => {
    const doors: Record<DoorKind, Map<string, string>> = { automation: new Map(), gate: new Map(), intake: new Map() };
    return {
        ensure: async (kind, id) => {
            const existing = doors[kind].get(id);
            if (existing !== undefined) {
                return existing;
            }
            const minted = mintFor(kind);
            doors[kind].set(id, minted);
            return minted;
        },
        peek: async (kind, id) => doors[kind].get(id),
        verify: async (kind, id, presented) => {
            const token = doors[kind].get(id);
            return token !== undefined && presented !== "" && tokenEquals(presented, token);
        },
        rotate: async (kind, id) => {
            const minted = mintFor(kind);
            doors[kind].set(id, minted);
            return minted;
        },
        remove: async (kind, id) => {
            doors[kind].delete(id);
        },
    };
};

// The credential a door's caller presented: a webhook sender can only carry a URL, so `?token=` stays accepted
// everywhere.
// A caller that can set a header sends a bearer instead, safer than a query string (edge/tunnel logs); the header wins
// when both are present.
export const presentedDoorToken = (headers: { get: (name: string) => string | null | undefined }, query: string | undefined): string => {
    const authorization = headers.get("authorization") ?? "";
    if (authorization.startsWith("Bearer ")) {
        return authorization.slice("Bearer ".length);
    }
    return query ?? "";
};
