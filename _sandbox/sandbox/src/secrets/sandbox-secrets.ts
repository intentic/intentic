import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// Secrets a person keeps for the agent without DevOps: pasted into a need's card (docs/architecture/needs.md), or added
// on the Secrets view in a sandbox with no desired-state repo to hold a `.env`. Beside the capability vault under the
// auth root (mode 0600), off the file routes, the tree walk and the search index, and resolved by the same
// `{{secret:NAME}}` reference as every other store. Not a barrier against a shell, like the vault it sits beside.

// name -> value, one entry per secret, each parsed on its own.
export const sandboxSecretsDocument = defineDocument({ root: "auth", path: "sandbox-secrets.json", schema: z.string(), granularity: "record" });

// The store, telling `changed` after each write that moved something: what a need waiting on a secret reacts to, so it
// settles when the value is stored here by any door, not on the needs fallback timer (2026-10-20).
export const notifyingSandboxSecrets = (store: SandboxSecrets, changed: () => void): SandboxSecrets => ({
    ...store,
    set: async (name, value) => {
        await store.set(name, value);
        changed();
    },
    remove: async (name) => {
        const removed = await store.remove(name);
        if (removed) {
            changed();
        }
        return removed;
    },
});

export interface SandboxSecrets {
    readonly all: () => Promise<Readonly<Record<string, string>>>;
    readonly get: (name: string) => Promise<string | undefined>;
    readonly set: (name: string, value: string) => Promise<void>;
    // Whether there was one to remove.
    readonly remove: (name: string) => Promise<boolean>;
}

export const fileSandboxSecrets = (path: string): SandboxSecrets => {
    const file = openDocument(sandboxSecretsDocument, path, {
        fallback: (): Record<string, string> => ({}),
        mode: 0o600,
        // A fresh store over an unreadable one would drop every secret in it.
        onUnreadable: "refuse",
        atRestPurpose: sandboxSecretsDocument.path,
    });
    return {
        all: () => file.read(),
        get: async (name) => (await file.read())[name],
        set: async (name, value) => {
            await file.update((current) => ({ ...current, [name]: value }));
        },
        remove: async (name) => {
            let removed = false;
            await file.update((current) => {
                if (!(name in current)) {
                    return current;
                }
                removed = true;
                const { [name]: _dropped, ...rest } = current;
                return rest;
            });
            return removed;
        },
    };
};
