import { oneLine } from "@intentic/base/one-line";
import { z } from "zod";
import { opt } from "../opt.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// The owner's yeses that name no conversation: they hold in every conversation, so they are kept beside the
// per-conversation ones (personas/conversation-grants.ts) under the auth root, off the workspace an agent writes, and
// listed and taken back through the same door (needs/standing-grants.ts, the Access tab's Sandbox-wide permissions).
// Today one kind lives here: a permission card's "Always: <line>" on a command, which joins the safety judge's policy
// until somebody takes it back. It used to be a bullet appended to .intentic/config/safety.md, which an agent edits as
// freely as its owner does, which nothing listed and which only a hand edit could take back; rejected. Approved hook
// sets and approved extensions are owner-wide yeses too, and stay in their own digest-pinned ledgers under the history
// root (guard/hook-approvals.ts, extensions/extension-approvals.ts) which the same list reads.

const CommandPolicyGrantSchema = z.object({
    line: z.string().min(1),
    at: z.number(),
    by: z.string().optional(),
});
export type CommandPolicyGrant = z.infer<typeof CommandPolicyGrantSchema>;

const OwnerGrantsFileSchema = z.object({ commandPolicy: z.array(CommandPolicyGrantSchema).default([]) });
type OwnerGrantsFile = z.output<typeof OwnerGrantsFileSchema>;

export const ownerGrantsDocument = defineDocument({ root: "auth", path: "owner-grants.json", schema: OwnerGrantsFileSchema });

// One policy line as the judge reads it and the list shows it: a single line of prose, whatever the model wrapped it in,
// with the control and direction-changing characters a card could hide something behind taken out. Never cut short.
export const commandPolicyLine = (line: string): string => oneLine(line);

export interface OwnerGrantsReading {
    readonly commandPolicy: readonly CommandPolicyGrant[];
    // The file exists and this build cannot read it: no owner-wide yes stands until it is fixed, which is the stricter side.
    readonly unreadable: boolean;
}

// Reads the allowed lines for the safety judge's policy (safety/safety-policy-store.ts). A file this build cannot read
// grants nothing, the stricter side, and says so in the log rather than quietly judging by less than the owner allowed.
export const commandPolicyLines =
    (grants: Pick<OwnerGrants, "read">, warn: (message: string) => void): (() => Promise<readonly string[]>) =>
    async () => {
        const { commandPolicy, unreadable } = await grants.read();
        if (unreadable) {
            warn(`owner grants: ${ownerGrantsDocument.path} could not be read, so the lines allowed with Always are not in the safety policy until it is fixed`);
        }
        return commandPolicy.map((grant) => grant.line);
    };

export interface OwnerGrants {
    // Every command policy line allowed with Always, oldest first.
    readonly read: () => Promise<OwnerGrantsReading>;
    // Adds the line; false when it already stood or said nothing.
    readonly allowCommandPolicy: (line: string, by: string | undefined) => Promise<boolean>;
    // Whether there was one to take back.
    readonly revokeCommandPolicy: (line: string) => Promise<boolean>;
    // Hears every write that changed something, after it landed; returns the unsubscribe.
    readonly onChange: (listener: () => void) => () => void;
}

// What the grants are kept in: the auth-root document in the daemon, a plain object in memory for a suite.
interface OwnerGrantsStorage {
    readonly state: () => Promise<{ readonly value: OwnerGrantsFile; readonly unreadable: boolean }>;
    readonly update: (change: (current: OwnerGrantsFile) => OwnerGrantsFile) => Promise<OwnerGrantsFile>;
}

export const fileOwnerGrants = (path: string, now: () => number = Date.now): OwnerGrants =>
    ownerGrantsOver(
        openDocument(ownerGrantsDocument, path, {
            fallback: (): OwnerGrantsFile => ({ commandPolicy: [] }),
            mode: 0o600,
            // A fresh file over an unreadable one would quietly take back every yes the owner gave.
            onUnreadable: "refuse",
        }),
        now,
    );

export const memoryOwnerGrants = (now: () => number = Date.now): OwnerGrants => {
    let kept: OwnerGrantsFile = { commandPolicy: [] };
    return ownerGrantsOver(
        {
            state: async () => ({ value: kept, unreadable: false }),
            update: async (change) => {
                kept = change(kept);
                return kept;
            },
        },
        now,
    );
};

const ownerGrantsOver = (storage: OwnerGrantsStorage, now: () => number): OwnerGrants => {
    const listeners = new Set<() => void>();
    // A write that handed the file back as it was is no news; anything else is announced once it has landed.
    const write = async (change: (current: OwnerGrantsFile) => OwnerGrantsFile): Promise<boolean> => {
        let changed = false;
        await storage.update((current) => {
            const next = change(current);
            changed = next !== current;
            return next;
        });
        if (changed) {
            for (const listener of listeners) {
                try {
                    listener();
                } catch {
                    // allow(silent-catch): a listener only refreshes a view; the yes is already written, and its failure must not undo or fail that.
                }
            }
        }
        return changed;
    };
    return {
        read: async () => {
            const { value, unreadable } = await storage.state();
            return { commandPolicy: unreadable ? [] : value.commandPolicy, unreadable };
        },
        allowCommandPolicy: (line, by) => {
            const said = commandPolicyLine(line);
            return said === ""
                ? Promise.resolve(false)
                : write((current) =>
                      current.commandPolicy.some((grant) => grant.line === said)
                          ? current
                          : { ...current, commandPolicy: [...current.commandPolicy, { line: said, at: now(), ...opt("by", by) }] },
                  );
        },
        revokeCommandPolicy: (line) => {
            const said = commandPolicyLine(line);
            return write((current) =>
                current.commandPolicy.some((grant) => grant.line === said)
                    ? { ...current, commandPolicy: current.commandPolicy.filter((grant) => grant.line !== said) }
                    : current,
            );
        },
        onChange: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
};
