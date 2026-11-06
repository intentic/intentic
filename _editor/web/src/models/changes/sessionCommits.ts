import { sandboxShallowRef } from "@intentic/extension-api";

// THE COMMITS A CHAT MADE OF ITS OWN LANDED WORK, per sandbox: in which repositories, and how many in each. The strip
// above a chat's composer (ChatShipStrip.vue) reads it to offer the push that sends them, and to say when that push
// would carry other work too, since git pushes a branch, never one commit. Memory only: a reload forgets it, and the
// push is then the Changes panel's to offer, as it always was.

/** Commits a chat recorded, by repository. */
export type SessionCommits = Readonly<Record<string, number>>;

const ledger = sandboxShallowRef<ReadonlyMap<string, SessionCommits>>(() => new Map());

/** One more commit in each of `repos`, recorded for the conversation `id`. */
export const recordSessionCommit = (id: string, repos: readonly string[]): void => {
    const held = ledger.value.get(id) ?? {};
    const counted = Object.fromEntries([...new Set(repos)].map((repo) => [repo, (held[repo] ?? 0) + 1]));
    ledger.value = new Map(ledger.value).set(id, { ...held, ...counted } satisfies SessionCommits);
};

/** What the conversation `id` has committed and not yet seen pushed; undefined for none. */
export const sessionCommitsOf = (id: string): SessionCommits | undefined => ledger.value.get(id);

/** Forgets the conversation's commits, once they have left this machine or there is nowhere to send them. */
export const forgetSessionCommits = (id: string): void => {
    if (!ledger.value.has(id)) {
        return;
    }
    const next = new Map(ledger.value);
    next.delete(id);
    ledger.value = next;
};
