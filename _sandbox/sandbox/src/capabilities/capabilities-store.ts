import { type Capability, CapabilitySchema, VAULTED } from "@intentic/sandbox-contract";
import { jsonFile } from "../store/json-file.js";
import type { ResolvedContribution } from "./contributions.js";
import { partitionSecretValues } from "./secret-fields.js";
import type { SecretVault } from "./secret-vault.js";

// The sandbox-owned manifest of active capabilities (<workspace>/.intentic/config/capabilities.json). Source of truth
// for what's active; mcp entries also feed the agent's MCP servers. Off the daemon's file ROUTES (the
// control-plane denylist), which is a bound on the browser and never was one on the agent — it holds a shell,
// and this file is meant to be readable and editable by it. So the credential VALUES are not in here at all:
// withSecretVault below keeps them off /work and leaves a marker, and reads rehydrate.
//
// Entries are validated ONE AT A TIME, and an entry that fails validation is skipped rather than failing the
// read. Parsing the file as `z.array(CapabilitySchema)` made a single bad entry return an EMPTY manifest — so
// one stale entry (a kind whose config shape changed under it, or a hand-edit) silently took down every
// unrelated capability with it: devops, docker, mcp, ssh. The blast radius has to be the one bad entry.
//
// A skipped entry is preserved in the file, never rewritten away: the writes below operate on the RAW array, so
// an entry this daemon can't read stays intact for a daemon that can (and for the user to fix by re-adding it).
export interface CapabilitiesStore {
    readonly list: () => Promise<Capability[]>;
    readonly get: (id: string) => Promise<Capability | undefined>;
    // Upsert by id (re-adding the same id edits its config).
    readonly upsert: (capability: Capability) => Promise<void>;
    // True when a capability of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// An entry's id without trusting its shape — enough to key the raw read-modify-write below, and to name the
// entry in the warning when it doesn't validate.
const rawId = (entry: unknown): string | undefined => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
};

// A JSON file store, used in production at <workspace>/.intentic/config/capabilities.json. A skipped entry is
// reported twice over, because the two audiences are in different places: `onInvalid` puts it in the daemon
// log for whoever is reading logs, and the manifest-problem registry puts it on the screen where the
// capability went missing. Until the second one existed, "never silent" was only true of the log.
export const fileCapabilitiesStore = (path: string, onInvalid?: (id: string, reason: string) => void): CapabilitiesStore => {
    // Typed as the RAW array the writes preserve, not as Capability[] — per-entry validation happens in `read`
    // below so one unreadable entry costs itself and not the manifest. The schema check here is only "is this
    // a JSON array at all"; anything else reads as empty, which is also what a torn file used to read as
    // before jsonFile made torn files unobservable.
    /* Entries are checked HERE, inside `parse`, rather than in `read` below — because this is the only point
     * with a `report` channel, and a skipped capability has to reach the browser and not just the log. The
     * value still comes back RAW: a write must preserve an entry this build cannot read (see above), which a
     * validated array could not express.
     *
     * `read` then validates a second time to produce the typed list. That is one extra pass over a manifest
     * that has already been read off disk and JSON-parsed, and it buys a single obvious validation site per
     * concern instead of a shared one that has to smuggle its findings between the two. */
    const file = jsonFile<unknown[]>(path, {
        parse: (raw, report) => {
            if (!Array.isArray(raw)) {
                return undefined;
            }
            for (const entry of raw) {
                const parsed = CapabilitySchema.safeParse(entry);
                if (parsed.success) {
                    continue;
                }
                const id = rawId(entry) ?? "<unnamed>";
                const reason = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
                onInvalid?.(id, reason);
                report({ kind: "invalidEntry", detail: `${id} — ${reason}` });
            }
            return raw;
        },
        fallback: () => [],
    });
    const read = async (): Promise<Capability[]> =>
        (await file.read()).flatMap((entry) => {
            const parsed = CapabilitySchema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
        });
    return {
        list: read,
        get: async (id) => (await read()).find((capability) => capability.id === id),
        upsert: async (capability) => {
            await file.update((entries) => [...entries.filter((entry) => rawId(entry) !== capability.id), capability]);
        },
        remove: async (id) => {
            let removed = false;
            await file.update((entries) => {
                const next = entries.filter((entry) => rawId(entry) !== id);
                removed = next.length !== entries.length;
                // Unchanged by reference when nothing matched, so a remove of an absent id writes nothing.
                return removed ? next : entries;
            });
            return removed;
        },
    };
};

/* THE SPLIT: credential values live in the vault, the manifest keeps the shape of the connection.
 *
 * A decorator rather than a change to the file store, because the two concerns are genuinely separate — the
 * store's job is one JSON file read/written whole with per-entry validation, and this one's is which of an
 * entry's fields may be in that file at all. It also composes the way the trial endpoint already does.
 *
 * Reads REHYDRATE, so every existing caller — env composition, the connection route, type_credential, the OTP
 * minter — keeps receiving a whole Capability and none of them had to learn about the vault. The split is a
 * fact about the bytes on disk, which is exactly where the exposure was.
 *
 * Writes go to the VAULT FIRST. The other order loses a credential outright when the second write fails (the
 * manifest would hold markers with nothing behind them); this order's failure mode is an orphaned vault row for
 * an entry that never landed, which the next upsert of that id overwrites and nothing reads meanwhile.
 */
const hydrate = (capability: Capability, values: Record<string, string>): Capability =>
    Object.keys(values).length === 0 ? capability : ({ ...capability, config: { ...capability.config, ...values } } as Capability);

export const withSecretVault = (
    inner: CapabilitiesStore,
    vault: SecretVault,
    connectors: () => Promise<Map<string, ResolvedContribution>>,
    onUnvaultable?: (id: string, fields: readonly string[]) => void,
): CapabilitiesStore => {
    return {
        list: async () => {
            const [entries, resolved] = await Promise.all([inner.list(), vault.all()]);
            return entries.map((entry) => hydrate(entry, resolved[entry.id] ?? {}));
        },
        get: async (id) => {
            const entry = await inner.get(id);
            return entry === undefined ? undefined : hydrate(entry, await vault.get(id));
        },
        upsert: async (capability) => {
            const { values, unvaultable } = partitionSecretValues(capability, await connectors());
            if (unvaultable.length > 0) {
                onUnvaultable?.(capability.id, unvaultable);
            }
            /* A caller that read from somewhere WITHOUT rehydration and wrote back would otherwise vault the
             * marker over the real value — a silent credential loss, and the one way this decorator could
             * destroy data. The stored value wins whenever the incoming one is the marker. */
            const stored = await vault.get(capability.id);
            const merged = Object.fromEntries(
                Object.entries(values).map(([key, value]) => [key, value === VAULTED ? (stored[key] ?? value) : value]),
            );
            await vault.set(capability.id, merged);
            const config = { ...(capability.config as Record<string, unknown>) };
            for (const key of Object.keys(merged)) {
                config[key] = VAULTED;
            }
            await inner.upsert({ ...capability, config } as Capability);
        },
        remove: async (id) => {
            const removed = await inner.remove(id);
            await vault.remove(id);
            return removed;
        },
    };
};

/* THE SPLIT AS AN INVARIANT RATHER THAN A WRITE-TIME HABIT — answers the ids it had to move.
 *
 * `upsert` above is the only thing that vaults, so the manifest holds the shape of a connection only for the
 * entries written since it did. Every OTHER entry — one saved before the split existed, one the agent pasted a
 * real token back into with its own file tools, one restored from an export — sits in .intentic/config/capabilities.json
 * with the credential still in it, and nothing rewrites it because nothing re-saves a service that is working.
 * The manifest is deliberately readable and deliberately editable, so "a credential is in there" is a state the
 * system can re-enter at any time, not a leftover of one version. Hence a sweep that runs on every boot and
 * says nothing when there is nothing to move, rather than a conversion that runs once.
 *
 * It moves values by re-upserting through the decorator, so there is one implementation of what gets vaulted
 * and what stands in its place. Entries whose secret fields all read as the marker are left untouched — an
 * already-correct manifest is never rewritten, which is what keeps this from churning the file (and its
 * watchers) on every restart.
 */
export const vaultManifestSecrets = async (
    inner: CapabilitiesStore,
    vault: SecretVault,
    connectors: () => Promise<Map<string, ResolvedContribution>>,
    onUnvaultable?: (id: string, fields: readonly string[]) => void,
): Promise<readonly string[]> => {
    const resolved = await connectors();
    const store = withSecretVault(inner, vault, async () => resolved, onUnvaultable);
    const moved: string[] = [];
    // The RAW manifest, deliberately: the decorated read rehydrates, which would show a vaulted entry exactly
    // as it shows one that never left the file — the difference this has to see.
    for (const entry of await inner.list()) {
        const { values } = partitionSecretValues(entry, resolved);
        if (Object.values(values).every((value) => value === VAULTED)) {
            continue;
        }
        /* What READERS currently see, not what the file says. `hydrate` gives the vault priority over the
         * manifest, so an entry carrying a value in both places is already being used from the vault — moving
         * the file's copy in would quietly swap the credential a working service authenticates with. */
        await store.upsert(hydrate(entry, await vault.get(entry.id)));
        moved.push(entry.id);
    }
    return moved;
};
