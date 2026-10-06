import type { AdoptionTicket, SandboxLookup, SandboxSummary } from "@intentic/api-contract";
import { errorMessage } from "@intentic/base/errors";
import { type RelinkAnswer, type RelinkRequest, sandboxIdOfDaemonUrl } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/client";
import { computed, ref } from "vue";
import type { RememberedSandbox } from "../../../client/directory/deviceDirectory";

// THE RECOVERY SCREEN'S WORK (Recover.vue, README.md): the sandboxes this device remembers and the account's list
// lacks, each asked whether it answers and what the platform holds of it, then brought back on the owner's press. Every
// effect is a dependency, so the order (probe, ask, sort; then session, ticket, relink) is what the suite pins.

export type CandidateState =
    | { readonly kind: `checking` }
    // Answers, and the platform has no record of it: the owner's to reconnect.
    | { readonly kind: `recoverable`; readonly sandboxId: string }
    | { readonly kind: `reconnecting`; readonly sandboxId: string }
    // Back in the list; `byAddress` when only its address could be recorded (a daemon too old to be adopted).
    | { readonly kind: `reconnected`; readonly byAddress: boolean }
    // Nothing answers at its address right now.
    | { readonly kind: `offline` }
    // Someone else's that this account was invited to: only its owner can bring the share back.
    | { readonly kind: `shared` }
    | { readonly kind: `failed`; readonly message: string; readonly sandboxId: string | undefined };

export interface Candidate {
    readonly entry: RememberedSandbox;
    readonly state: CandidateState;
}

export interface RecoveryDeps {
    // The sandboxes to look at, in the order to show them.
    readonly candidates: () => readonly RememberedSandbox[];
    // The 12-hex id the daemon's /health names, or undefined when nothing answers there.
    readonly health: (daemonUrl: string) => Promise<{ readonly sandboxId: string | undefined } | undefined>;
    readonly lookup: (sandboxIds: readonly string[]) => Promise<SandboxLookup[`sandboxes`]>;
    readonly ticket: (sandboxId: string) => Promise<AdoptionTicket>;
    // A daemon bearer for this sandbox, signing in with Google if need be; undefined when the reader declined.
    readonly bearer: (entry: RememberedSandbox) => Promise<string | undefined>;
    // The daemon's answer to a Reconnect, or `unsupported` from one too old to serve it.
    readonly relink: (entry: RememberedSandbox, bearer: string, request: RelinkRequest) => Promise<RelinkAnswer | `unsupported`>;
    // Records the sandbox by its address alone (the setup screen's attach): the fallback for an old daemon.
    readonly attach: (entry: RememberedSandbox) => Promise<void>;
    readonly refreshList: () => Promise<readonly SandboxSummary[]>;
    // Lets go of a sandbox this account no longer has (deleted, someone else's, or the reader's Forget).
    readonly forget: (entry: RememberedSandbox) => void;
}

const failed = (message: string, sandboxId: string | undefined): CandidateState => ({ kind: `failed`, message, sandboxId });

// The platform said no to a ticket: already listed is a reconnect that happened elsewhere, a platform that cannot vouch
// is the attach fallback, anything else the reason it gave.
type TicketRefusal = `listed` | `unvouched` | { readonly message: string };

const ticketRefusalOf = (error: Error): TicketRefusal => {
    if (error instanceof ORPCError && error.code === `CONFLICT` && error.message === `this sandbox is already in your list`) {
        return `listed`;
    }
    if (error instanceof ORPCError && error.code === `PRECONDITION_FAILED`) {
        return `unvouched`;
    }
    return { message: errorMessage(error) };
};

export const useRecovery = (deps: RecoveryDeps) => {
    const candidates = ref<Candidate[]>([]);
    const checked = ref(false);

    const set = (entry: RememberedSandbox, state: CandidateState): void => {
        candidates.value = candidates.value.map((candidate) => (candidate.entry.daemonUrl === entry.daemonUrl ? { entry, state } : candidate));
    };
    const drop = (entry: RememberedSandbox): void => {
        candidates.value = candidates.value.filter((candidate) => candidate.entry.daemonUrl !== entry.daemonUrl);
    };

    // What the platform holds of one answering sandbox decides what the screen offers for it.
    const sortOne = (entry: RememberedSandbox, sandboxId: string, standing: SandboxLookup[`sandboxes`][number][`standing`] | undefined): void => {
        if (standing === undefined) {
            set(entry, failed(`intentic could not be asked about this sandbox: check again in a moment`, sandboxId));
        } else if (standing === `yours`) {
            set(entry, { kind: `reconnected`, byAddress: false });
        } else if (standing === `deleted` || standing === `other`) {
            deps.forget(entry);
            drop(entry);
        } else {
            set(entry, entry.role === `owner` ? { kind: `recoverable`, sandboxId } : { kind: `shared` });
        }
    };

    // Probes every candidate at once, then asks the platform about the ones that answered in one question.
    const check = async (): Promise<void> => {
        const entries = deps.candidates();
        candidates.value = entries.map((entry) => ({ entry, state: { kind: `checking` } }));
        const answered = (
            await Promise.all(
                entries.map(async (entry) => {
                    const health = await deps.health(entry.daemonUrl);
                    const sandboxId = health?.sandboxId ?? sandboxIdOfDaemonUrl(entry.daemonUrl);
                    if (health === undefined || sandboxId === undefined) {
                        set(entry, { kind: `offline` });
                        return [];
                    }
                    return [{ entry, sandboxId }];
                }),
            )
        ).flat();
        if (answered.length > 0) {
            // allow(silent-catch): no answer is shown, not swallowed: sortOne marks each sandbox "could not be asked, check again".
            const standings = await deps.lookup(answered.map((each) => each.sandboxId)).catch(() => undefined);
            for (const { entry, sandboxId } of answered) {
                sortOne(entry, sandboxId, standings?.find((held) => held.sandboxId === sandboxId)?.standing);
            }
        }
        checked.value = true;
    };

    // The adoption, once the platform handed over a ticket: the daemon registers, after having the platform make its row.
    const relinkWith = async (entry: RememberedSandbox, sandboxId: string, bearer: string, ticket: string): Promise<CandidateState> => {
        // The name and logo this device remembers, since only the platform held them and it has lost them.
        const request: RelinkRequest = { ticket, name: entry.name };
        if (entry.image !== null) {
            request.image = entry.image;
        }
        const answer = await deps.relink(entry, bearer, request);
        if (answer === `unsupported`) {
            await deps.attach(entry);
            await deps.refreshList();
            return { kind: `reconnected`, byAddress: true };
        }
        if (answer.announce.state === `registered`) {
            await deps.refreshList();
            return { kind: `reconnected`, byAddress: false };
        }
        return failed(answer.adoption?.detail ?? answer.announce.detail ?? `the sandbox could not register with intentic`, sandboxId);
    };

    const reconnectOne = async (entry: RememberedSandbox, sandboxId: string): Promise<CandidateState> => {
        const bearer = await deps.bearer(entry);
        if (bearer === undefined) {
            return failed(`sign in with Google to reconnect it`, sandboxId);
        }
        let ticket: AdoptionTicket;
        try {
            ticket = await deps.ticket(sandboxId);
        } catch (error) {
            const refusal = ticketRefusalOf(error instanceof Error ? error : new Error(String(error)));
            if (refusal === `listed`) {
                await deps.refreshList();
                return { kind: `reconnected`, byAddress: false };
            }
            if (refusal === `unvouched`) {
                await deps.attach(entry);
                await deps.refreshList();
                return { kind: `reconnected`, byAddress: true };
            }
            return failed(refusal.message, sandboxId);
        }
        return relinkWith(entry, sandboxId, bearer, ticket.ticket);
    };

    const reconnect = async (entry: RememberedSandbox, sandboxId: string): Promise<void> => {
        set(entry, { kind: `reconnecting`, sandboxId });
        try {
            set(entry, await reconnectOne(entry, sandboxId));
        } catch (error) {
            set(entry, failed(errorMessage(error), sandboxId));
        }
    };

    // One at a time: each may ask for a Google sign-in, and two prompts at once is one too many.
    const reconnectAll = async (): Promise<void> => {
        for (const candidate of candidates.value) {
            if (candidate.state.kind === `recoverable`) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one sign-in prompt at a time, by design
                await reconnect(candidate.entry, candidate.state.sandboxId);
            }
        }
    };

    const forget = (entry: RememberedSandbox): void => {
        deps.forget(entry);
        drop(entry);
    };

    const recoverable = computed(() => candidates.value.filter((candidate) => candidate.state.kind === `recoverable`).length);
    const reconnected = computed(() => candidates.value.filter((candidate) => candidate.state.kind === `reconnected`).length);
    const busy = computed(() => candidates.value.some((candidate) => candidate.state.kind === `checking` || candidate.state.kind === `reconnecting`));

    return { candidates, checked, recoverable, reconnected, busy, check, reconnect, reconnectAll, forget };
};
