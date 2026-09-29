import {
    type CredentialGateKind,
    hostAllowed,
    normalizeHostPattern,
    type SecretHostGuard,
    SECRET_HOSTS_MAX,
    type SecretInventoryEntry,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { contributionFor, contributionHosts, contributionRegistry } from "../capabilities/contributions.js";
import type { ExtensionHost } from "../extensions/installed-extensions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { gateTargetOf } from "./credential-gates.js";
import type { Destination } from "./secret-destinations.js";

// The host guard, each secret's second approval setting beside its named approvers: on, a use goes unasked only to the
// hosts on its list and anything else waits for a person; off, it never asks. The owner's settings are stored off the
// workspace beside the gate policy (mode 0600), since `.intentic/config/` is agent-editable and a turn must not loosen
// its own guard; a connector's own hosts guard the credential it holds until the owner says otherwise. Read by the check
// at every exit a value leaves through (host-guard-gate.ts), by the routes, and joined onto the inventory.

// `<kind>:<subject>` -> the owner's setting. Off with a list keeps the list for turning the guard back on, and off over
// a connector's default is how the owner turns that default off. Hosts are kept as plain strings and normalized on read,
// so a pattern rule a later build tightens drops a host (a tighter list) instead of making the whole file unreadable.
export const secretHostGuardsDocument = defineDocument({
    root: "auth",
    path: "secret-hosts.json",
    schema: z.object({ guard: z.boolean(), hosts: z.array(z.string()) }),
    granularity: "record",
});

// One owner-written setting, as stored.
export interface StoredHostGuard {
    readonly subject: string;
    readonly kind: CredentialGateKind;
    readonly guard: boolean;
    readonly hosts: readonly string[];
}

export interface SecretHostGuardsStore {
    // Every owner-written setting; `[]` if never written, and throws when the file exists but cannot be read, since
    // empty here would read as every guard off.
    readonly list: () => Promise<readonly StoredHostGuard[]>;
    // Replaces one subject's setting.
    readonly set: (setting: StoredHostGuard) => Promise<void>;
    // Drops one subject's setting, so a connector's default applies again, or nothing.
    readonly remove: (subject: string, kind: CredentialGateKind) => Promise<void>;
}

const KINDS: ReadonlySet<string> = new Set<CredentialGateKind>(["secret", "capability"]);
const keyOf = (kind: CredentialGateKind, subject: string): string => `${kind}:${subject}`;

// A stored key back to what it names; undefined for one this build does not know, which is skipped.
const entryOf = (key: string, entry: { readonly guard: boolean; readonly hosts: readonly string[] }): StoredHostGuard | undefined => {
    const colon = key.indexOf(":");
    const kind = key.slice(0, colon);
    if (colon === -1 || !KINDS.has(kind)) {
        return undefined;
    }
    return {
        subject: key.slice(colon + 1),
        kind: kind === "capability" ? "capability" : "secret",
        guard: entry.guard,
        hosts: entry.hosts.flatMap((host) => normalizeHostPattern(host) ?? []).slice(0, SECRET_HOSTS_MAX),
    };
};

export const fileSecretHostGuards = (path: string): SecretHostGuardsStore => {
    const file = openDocument(secretHostGuardsDocument, path, {
        fallback: (): Record<string, { guard: boolean; hosts: string[] }> => ({}),
        mode: 0o600,
        // A fresh store over an unreadable one would turn every guard in it off.
        onUnreadable: "refuse",
    });
    return {
        list: async () => {
            const state = await file.state();
            if (state.unreadable) {
                throw new Error(`the secret host guards at ${path} could not be read (${state.detail})`);
            }
            return Object.entries(state.value).flatMap(([key, entry]) => entryOf(key, entry) ?? []);
        },
        set: async ({ subject, kind, guard, hosts }) => {
            await file.update((current) => ({ ...current, [keyOf(kind, subject)]: { guard, hosts: [...hosts] } }));
        },
        remove: async (subject, kind) => {
            await file.update((current) => {
                const key = keyOf(kind, subject);
                if (!(key in current)) {
                    return current;
                }
                const { [key]: _dropped, ...rest } = current;
                return rest;
            });
        },
    };
};

// The hosts each connected capability's connector declares for its credential, expanded over that capability's own
// settings (a self-hosted instance's URL). A capability whose connector declares none, or whose templates come out empty,
// has no default.
export const connectorHostDefaults = async (host: ExtensionHost): Promise<ReadonlyMap<string, readonly string[]>> => {
    const registry = await contributionRegistry(host);
    const defaults = new Map<string, readonly string[]>();
    for (const capability of await host.capabilities.list()) {
        // Only a cli connector's credential reaches a command as a reference; the other kinds mount instead.
        if (capability.kind !== "cli") {
            continue;
        }
        const connector = contributionFor(registry, "cli", capability.config);
        const hosts = connector === undefined ? [] : contributionHosts(connector.spec, capability.config);
        if (hosts.length > 0) {
            defaults.set(capability.id, hosts);
        }
    }
    return defaults;
};

// The guards in force: the owner's setting, where written, else a connector's default for its capability, which is on.
// What every check and every read answers from.
export const effectiveHostGuards = (stored: readonly StoredHostGuard[], defaults: ReadonlyMap<string, readonly string[]>): SecretHostGuard[] => {
    const owned: SecretHostGuard[] = stored.map((setting) => ({
        subject: setting.subject,
        kind: setting.kind,
        guard: setting.guard,
        hosts: [...setting.hosts],
        source: "owner",
    }));
    const decided = new Set(stored.filter((setting) => setting.kind === "capability").map((setting) => setting.subject));
    const connectors: SecretHostGuard[] = [...defaults]
        .filter(([id]) => !decided.has(id))
        .map(([id, hosts]) => ({ subject: id, kind: "capability", guard: true, hosts: [...hosts], source: "connector" }));
    return [...owned, ...connectors];
};

// The guard covering one registry name (`GITHUB_TOKEN`, `github/token`), by the gate's own subject rule.
export const guardForName = (guards: readonly SecretHostGuard[], name: string): SecretHostGuard | undefined => {
    const { subject, kind } = gateTargetOf(name);
    return guards.find((guard) => guard.kind === kind && guard.subject === subject);
};

// The guard for one inventory row, by the same subject rule as its gate; a model account's row has none.
export const guardForEntry = (guards: readonly SecretHostGuard[], entry: Pick<SecretInventoryEntry, "key" | "kind">): SecretHostGuard | undefined => {
    const kind = entry.kind === "capability" ? "capability" : "secret";
    return entry.kind === "provider" ? undefined : guards.find((guard) => guard.kind === kind && guard.subject === entry.key);
};

// One secret a use spends whose guard is on, and the hosts it may go to unasked; empty, it may go nowhere unasked.
export interface GuardedName {
    readonly name: string;
    readonly hosts: readonly string[];
}

// What a use's destination means against the guards of the secrets it spends. "outside" names the hosts off some list.
export type HostReading =
    | { readonly destination: "none" }
    | { readonly destination: "inside"; readonly guarded: readonly GuardedName[] }
    | { readonly destination: "outside"; readonly guarded: readonly GuardedName[]; readonly hosts: readonly string[] }
    | { readonly destination: "unreadable"; readonly guarded: readonly GuardedName[]; readonly why: string };

// Only a guard that is on is read. Every host the use names must be on every guarded secret's list: one request carries
// all of them to all of its hosts.
export const readHosts = (guards: readonly SecretHostGuard[], names: readonly string[], destination: Destination): HostReading => {
    const guarded = names.flatMap((name) => {
        const guard = guardForName(guards, name);
        return guard?.guard === true ? [{ name, hosts: guard.hosts }] : [];
    });
    if (guarded.length === 0) {
        return { destination: "none" };
    }
    if (!destination.certain) {
        return { destination: "unreadable", guarded, why: destination.why };
    }
    const outside = destination.hosts.filter((host) => guarded.some((entry) => !hostAllowed(entry.hosts, host)));
    return outside.length === 0 ? { destination: "inside", guarded } : { destination: "outside", guarded, hosts: outside };
};
