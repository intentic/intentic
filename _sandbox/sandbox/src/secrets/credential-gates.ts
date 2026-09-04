import { readFile } from "node:fs/promises";
import { type CredentialGate, type CredentialGateKind, CredentialGatesSchema } from "@intentic/sandbox-contract";
import { writeJsonFile } from "../store/json-file.js";

/* WHICH CREDENTIALS NEED A NAMED PERSON'S CLICK, as a file, and the one place that answer is stored.
 *
 * WHY IT LIVES OFF THE WORKSPACE. Beside the capability vault under `authRoot`, for the vault's own reason
 * rather than by association: `.intentic/config/` is tracked, reviewed and AGENT-EDITABLE, so a gate kept
 * there would be a lock with its key in the room — a turn that wanted the production password could edit the
 * policy that guards it, commit the edit as ordinary config housekeeping, and the owner would find out at
 * review time. Off-workspace, the only writers are the two owner-only routes, and the agent's own reach into
 * `/secrets` is the read (auth/grants.ts). Mode 0600 like the vault, for tidiness rather than for defence:
 * a shell in this container runs as the owner of both files, which SECURITY.md says out loud.
 *
 * WHY THE READ REFUSES INSTEAD OF FALLING BACK, the one place this store departs from every other
 * `*-store.ts` in the daemon. The house pattern (store/json-file.ts) reads an unparseable file as ABSENT and
 * carries on, which is exactly right for a manifest — a sandbox whose settings file lost a brace should boot
 * with defaults rather than not boot. It is exactly wrong here, because this file's empty state is
 * "nothing is gated": one corrupt byte would silently unlock every gated credential in the sandbox, and the
 * turn that spent one would look like an ordinary turn. So absent is absent (nothing gated yet, the ordinary
 * state) and UNREADABLE THROWS, and every caller that matters turns the throw into a refusal that names the
 * approvers (secrets/credential-gate.ts). Writes still go through the atomic sibling-rename this module's
 * neighbours use, so no reader can catch the policy half-written.
 *
 * WHAT A SUBJECT IS. An env or generated KEY (`DATABASE_URL`), or a capability id (`reddit`). Deliberately
 * never a vault name's field half: `reddit/password` and `reddit/totp` are two fields of one connected
 * account, and gating one without the other would be a gate with a hole in it, so the account is the unit and
 * `gateSubjectOf` is the one function that knows it. */

export interface CredentialGatesStore {
    /* Every gate in force. `[]` when the policy has never been written, which is most sandboxes; THROWS when
     * the file exists and cannot be read or does not parse, because the difference between those two decides
     * whether a credential is free or guarded and no caller may guess it. */
    readonly list: () => Promise<readonly CredentialGate[]>;
    // Upsert by subject: re-gating a subject replaces its approvers and scope rather than stacking a second
    // gate, so "who may release this" always has exactly one answer.
    readonly set: (gate: CredentialGate) => Promise<void>;
    readonly remove: (subject: string) => Promise<void>;
    // The gate covering one registry name (`DATABASE_URL`, `reddit/password`), by the subject rule below.
    readonly forName: (name: string) => Promise<CredentialGate | undefined>;
    readonly forCapability: (id: string) => Promise<CredentialGate | undefined>;
}

/* THE SUBJECT A REGISTRY NAME FALLS UNDER, the whole of the name→gate rule in one line. A name carrying a `/`
 * is a capability vault entry (`<capabilityId>/<field>`) and answers to its capability; anything else is an
 * env or generated key and answers to itself. The two namespaces are disjoint in practice — env keys are
 * SCREAMING_SNAKE and capability ids are not — so this needs no disambiguation beyond the slash. */
export const gateSubjectOf = (name: string): string => {
    const slash = name.indexOf("/");
    return slash === -1 ? name : name.slice(0, slash);
};

/* WHAT A REGISTRY NAME ASKS THE POLICY FOR, subject and kind together, because they are one decision and
 * every caller needs both: the gate check is handed a subject and a kind, and a call site deriving them
 * itself would be a second copy of the slash rule above. `reddit/password` asks about the CAPABILITY
 * `reddit`; `DATABASE_URL` asks about the SECRET of that name. */
export const gateTargetOf = (name: string): { readonly subject: string; readonly kind: CredentialGateKind } =>
    name.includes("/") ? { subject: gateSubjectOf(name), kind: "capability" } : { subject: name, kind: "secret" };

// The gate covering a registry name, over a list already in hand. The KIND is matched, not merely the
// subject, so a capability that happens to share an env key's name cannot answer for it.
export const gateForName = (gates: readonly CredentialGate[], name: string): CredentialGate | undefined => {
    const { subject, kind } = gateTargetOf(name);
    return gates.find((gate) => gate.kind === kind && gate.subject === subject);
};

export const gateForCapability = (gates: readonly CredentialGate[], id: string): CredentialGate | undefined =>
    gates.find((gate) => gate.kind === "capability" && gate.subject === id);

export const fileCredentialGates = (path: string): CredentialGatesStore => {
    // Writes are read-modify-write with an await in the middle, so they queue against each other: two gates
    // set from two browser tabs must both survive, and the second must not write a list it read before the
    // first landed. One chain per store, which is one file.
    let queue: Promise<unknown> = Promise.resolve();
    const list = async (): Promise<readonly CredentialGate[]> => {
        let text: string;
        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            // Absent is the ordinary first state: nothing has ever been gated here. Anything else (a
            // permission failure, a directory where the file should be) is a policy we cannot read, and this
            // store does not pretend that is the same thing.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return [];
            }
            throw new Error(`the credential gate policy at ${path} could not be read`, { cause: error });
        }
        // The parse is inside the refusal too, not only the read: unparseable JSON and a JSON document that
        // is not a policy are the same state to a caller — content we cannot act on — and letting
        // JSON.parse's own SyntaxError escape would send a caller a message about a brace instead.
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            throw new Error(`the credential gate policy at ${path} could not be read`);
        }
        const parsed = CredentialGatesSchema.safeParse(raw);
        if (!parsed.success) {
            throw new Error(`the credential gate policy at ${path} is not readable as a policy`);
        }
        return parsed.data.gates;
    };
    const write = async (change: (current: readonly CredentialGate[]) => readonly CredentialGate[]): Promise<void> => {
        const run = queue.then(async () => {
            const next = change(await list());
            await writeJsonFile(path, { gates: next }, 0o600);
        });
        // The chain must not break on a failed write: a refused edit is this caller's error to see, and the
        // next edit still has to queue behind it.
        queue = run.catch(() => undefined);
        await run;
    };
    return {
        list,
        set: (gate) => write((current) => [...current.filter((entry) => entry.subject !== gate.subject), gate]),
        remove: (subject) => write((current) => current.filter((entry) => entry.subject !== subject)),
        forName: async (name) => gateForName(await list(), name),
        forCapability: async (id) => gateForCapability(await list(), id),
    };
};
