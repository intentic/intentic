import { randomBytes } from "node:crypto";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import { tokenEquals } from "./auth.js";

/* DOOR TOKENS: the credentials behind the daemon's public doors, the routes an OUTSIDE system knocks on with
 * no Google identity and no control token, because it is a webhook sender or a pipeline runner that can carry
 * exactly one thing, a string it was handed once.
 *
 *   automation  POST /automations/{id}/fire       an event automation's webhook
 *   gate        POST /workflows/{id}/gate         a workflow's release gate
 *   intake      POST /intake/{id}/report          a bug intake's key, for a client with no Origin
 *
 * They used to live INSIDE the manifests that declare those doors (`trigger.token` in automations.json,
 * `gate.token` in workflows.json, `issues.ingestKey`), and those manifests are versioned: tracked in git, landed
 * into the owner's tree on every turn, readable by every agent turn and every viewer-tier member, carried in
 * exports. A credential has no business in a file with that audience. So they live here, in the secrets class
 * beside the CI webhook secret (workspace-state.ts), plaintext like it and for the same reason: the URL a
 * caller was taught has to be re-displayable to the maintainer who comes back for it months later, and a hash
 * would make every re-copy a rotation. What bounds the exposure is the audience: this file is locked from the
 * file API, and the routes attach a token to a listed automation or workflow for a maintainer or the owner
 * only, never for a viewer and never for a program's control token.
 *
 * `ensure` is the mint: called on save and, lazily, on the first list that needs the value, so a door declared
 * before this store existed gets its credential the first time somebody looks, and an owner who copies the URL
 * a second time gets the same one. `rotate` is the answer to a leaked URL that does not involve deleting the
 * automation and re-teaching every caller its id. */

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
    // Is this what the door was issued? Constant-time; false for a door with no credential and for the empty string.
    readonly verify: (kind: DoorKind, id: string, presented: string) => Promise<boolean>;
    // A fresh credential, the previous one retired in the same write.
    readonly rotate: (kind: DoorKind, id: string) => Promise<string>;
    // The door is gone (its automation deleted, its gate removed from the design): so is its credential.
    readonly remove: (kind: DoorKind, id: string) => Promise<void>;
}

// An intake key ships inside somebody's app binary and is read by people in a crash log; the prefix says what
// it is. The other two are only ever pasted into a secret store, and stay the bare value they always were.
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

/* THE CREDENTIAL A DOOR'S CALLER PRESENTED, from either of the two places one can ride.
 *
 * A webhook sender (GitHub, Sentry, a monitor) can carry exactly one thing, a URL, so `?token=` stays the form
 * every door accepts. A caller that CAN set a header, the gate CLI, the Marketplace action, a curl, sends the
 * same value as `authorization: Bearer …` instead, and the URL it dials carries nothing: a query string is the
 * least private part of a request (edge logs, the tunnel's logs, any proxy between), which is the whole reason
 * the browser's own credentials never travel there (ws-tickets.ts). The header wins when both are present, so
 * a stale token left in a pasted URL cannot override the one the caller meant. */
export const presentedDoorToken = (headers: { get: (name: string) => string | null | undefined }, query: string | undefined): string => {
    const authorization = headers.get("authorization") ?? "";
    if (authorization.startsWith("Bearer ")) {
        return authorization.slice("Bearer ".length);
    }
    return query ?? "";
};
