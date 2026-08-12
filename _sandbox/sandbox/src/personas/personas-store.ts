import { type Persona, PersonaSchema } from "@intentic/sandbox-contract";
import { jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/state-paths.js";

/* THE SANDBOX'S NAMED PERSONAS — the first file under .intentic the workspace repo tracked, and the argument
 * the rest of the tracked config slice was later carved out on (workspace-state.ts `versioned`).
 *
 * Most of that directory is excluded from version control on purpose: it is credentials — capability tokens,
 * provider OAuth, live browser profiles — plus ledgers and transcripts that are machine noise in a review. And
 * history/history.ts writes the exclude rules into the git dir OUTSIDE /work precisely so the agent cannot
 * loosen them. This file is the original deliberate hole in that wall, and it is safe for exactly one reason: a
 * persona card holds no secret. It is a name, a list of capability ids, some switches, and a folder or two. The
 * accounts it speaks for keep their cookies and passkeys where they already live, untracked and unexported.
 *
 * Committing it is the point, not a side effect. It means a persona can be added in a pull request and argued about
 * before it exists; it means `git log` answers "since when has the nightly job been posting as us"; and it means
 * a workspace cloned into a fresh sandbox arrives already knowing its own personas — every one listed, every one
 * of them visibly signed out, each needing one login before it can act. That is the same shape a connector
 * already has, so it needs no new idea to understand.
 *
 * IT IS NOT A CREDENTIAL STORE AND MUST NEVER BECOME ONE. If a future field would carry a token, it belongs in
 * the capability manifest with the other secrets — which is denylisted from the file API and excluded from git —
 * and this card should reference it by id, exactly as `capabilities` already does.
 *
 * NOR IS IT A SECURITY BOUNDARY, and the exclude carve-out is what makes that explicit: a tracked file is an
 * ordinary workspace file, which the agent can read and edit like any other. That is consistent with what this
 * layer promises (see PersonaSchema's note) — it prevents the wrong-account MISTAKE, and the place it genuinely
 * bites is the unattended wake, whose default is no accounts at all. An agent determined to misuse a connected
 * account never needed this file's permission in the first place. */

// Every card, in file order. An entry that fails validation is dropped rather than failing the read — the same
// per-entry tolerance the capability manifest has, and for the same reason: one hand-edited card must not take
// every other persona down with it, least of all on the turn path where the answer decides what a wake can touch.
export interface PersonasStore {
    readonly list: () => Promise<Persona[]>;
    readonly get: (id: string) => Promise<Persona | undefined>;
    // Upsert by id (re-adding the same id edits the card).
    readonly upsert: (persona: Persona) => Promise<void>;
    // True when a card of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// An entry's id without trusting its shape — enough to key the raw read-modify-write, and to name the entry in
// the warning when it doesn't validate.
const rawId = (entry: unknown): string | undefined => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
};

export const personasPath = (root: string): string => statePath(root, ".intentic/personas.json");

// A card that could not be read is reported to both places it has to reach: `onInvalid` to the daemon log, and
// the manifest-problem registry to the screen the persona vanished from. Same split as the capability manifest.
export const filePersonasStore = (path: string, onInvalid?: (id: string, reason: string) => void): PersonasStore => {
    // Typed as the RAW array so a write preserves entries this build could not read — a card written by a newer
    // build survives a rollback instead of being quietly dropped by the next edit. Cards are checked inside
    // `parse` because that is where the report channel is; `read` validates again for its typed result, which
    // is one extra pass over an already-parsed file (see capabilities-store for the same trade).
    const file = jsonFile<unknown[]>(path, {
        parse: (raw, report) => {
            if (!Array.isArray(raw)) {
                return undefined;
            }
            for (const entry of raw) {
                const parsed = PersonaSchema.safeParse(entry);
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
    const read = async (): Promise<Persona[]> =>
        (await file.read()).flatMap((entry) => {
            const parsed = PersonaSchema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
        });
    return {
        list: read,
        get: async (id) => (await read()).find((persona) => persona.id === id),
        upsert: async (persona) => {
            await file.update((entries) => [...entries.filter((entry) => rawId(entry) !== persona.id), persona]);
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
