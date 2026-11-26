import { join } from "node:path";
import type { ExtensionUpdatePolicy } from "@intentic/sandbox-contract/schemas/extension-updates";
import { z } from "zod";
import { stateRelPath } from "../state-paths.js";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";

// The owner's standing answer about extension updates (extension-updates.ts acts on it), kept at
// .intentic/config/extension-update-policy.json: each extension's own answer by its manifest identity, and the sandbox's
// default for every extension without one under DEFAULTS_KEY, which is never a manifest id (those start with a letter or
// digit). Nothing written at all means automatic updates and auto-disabled advisories.

const DEFAULTS_KEY = "*";

const PolicySchema = z.object({
    updates: z.enum(["notify", "agent", "auto"]).optional(),
    advisories: z.enum(["auto-disable", "notify"]).optional(),
});
type StoredPolicy = z.infer<typeof PolicySchema>;
export type PolicyFile = Record<string, StoredPolicy>;

export const extensionUpdatePolicyDocument = defineDocument({
    path: stateRelPath(".intentic/config/extension-update-policy.json"),
    schema: PolicySchema,
    granularity: "record",
});

// A handle per call: every handle on one path shares its write queue (queueOnFile).
const policyFile = (root: string): JsonFile<PolicyFile> =>
    openDocument(extensionUpdatePolicyDocument, join(root, extensionUpdatePolicyDocument.path), { fallback: () => ({}) });

// An extension's own answer, else the sandbox's default, else automatic.
const resolveUpdatePolicy = (stored: StoredPolicy | undefined, defaults?: StoredPolicy): ExtensionUpdatePolicy => ({
    updates: stored?.updates ?? defaults?.updates ?? "auto",
    advisories: stored?.advisories ?? defaults?.advisories ?? "auto-disable",
});

// The sandbox's default on its own: what an extension with no answer of its own follows.
export const resolveUpdateDefaults = (all: PolicyFile): ExtensionUpdatePolicy => resolveUpdatePolicy(undefined, all[DEFAULTS_KEY]);

// The answer that applies to one extension, out of the whole file.
export const policyOf = (all: PolicyFile, identity: string): ExtensionUpdatePolicy => resolveUpdatePolicy(all[identity], all[DEFAULTS_KEY]);

// Whether an extension answers about updates for itself, rather than following the sandbox.
export const ownsUpdateAnswer = (all: PolicyFile, identity: string): boolean => all[identity]?.updates !== undefined;

export const readUpdatePolicies = async (root: string): Promise<PolicyFile> => policyFile(root).read();

// What an extension's record becomes under a patch: `updates: "default"` drops its own answer, so it follows the
// sandbox's again. Built field by field, so an absent answer is absent from the file rather than `undefined` in it.
const patched = (
    current: StoredPolicy,
    patch: { updates?: ExtensionUpdatePolicy["updates"] | "default"; advisories?: ExtensionUpdatePolicy["advisories"] },
): StoredPolicy => {
    const { updates: own, ...rest } = current;
    const next: StoredPolicy = { ...rest };
    const updates = patch.updates === undefined ? own : patch.updates === "default" ? undefined : patch.updates;
    if (updates !== undefined) {
        next.updates = updates;
    }
    if (patch.advisories !== undefined) {
        next.advisories = patch.advisories;
    }
    return next;
};

// A record left with nothing in it goes from the file.
export const writeUpdatePolicy = async (
    root: string,
    identity: string,
    patch: { updates?: ExtensionUpdatePolicy["updates"] | "default"; advisories?: ExtensionUpdatePolicy["advisories"] },
): Promise<void> => {
    await policyFile(root).update((all) => {
        const next = patched(all[identity] ?? {}, patch);
        const { [identity]: _dropped, ...others } = all;
        return Object.keys(next).length === 0 ? others : { ...others, [identity]: next };
    });
};

export const writeUpdateDefaults = async (root: string, updates: ExtensionUpdatePolicy["updates"]): Promise<void> => {
    await policyFile(root).update((all) => ({ ...all, [DEFAULTS_KEY]: { ...all[DEFAULTS_KEY], updates } }));
};

// Removal is the one act that means the identity itself is going (extension-updates.ts forgetUpdateState).
export const forgetUpdatePolicy = async (root: string, identity: string): Promise<void> => {
    await policyFile(root).update((all) => {
        if (!(identity in all)) {
            // By reference, so jsonFile skips the write when there is nothing to drop.
            return all;
        }
        const { [identity]: _dropped, ...rest } = all;
        return rest;
    });
};
