import type { GitCommit } from "@intentic/sandbox-contract/schemas/git/git-history";
import { t } from "./i18n.js";

// Who a commit is by, and who it was for. An agent's commit has the sandbox itself as its author unless the sandbox's
// settings make the person the author, so every row of agent work read "intentic". The sandbox reads the person behind
// each from its Conversation-Id trailer (`requestedBy`), and this is where history says it.

// The sandbox's own commit address (AGENT_GIT_AUTHOR in _sandbox/sandbox/src/git-identity.ts), which an extension
// cannot import.
const AGENT_EMAIL = `agent@intentic.dev`;

// What to call the person the work was for: their name, else their address; nothing when nobody answers for the
// conversation, as for one an automation opened.
const requesterOf = (commit: GitCommit): string | undefined =>
    [commit.requestedBy?.name, commit.requestedBy?.email].find((part) => part !== undefined && part !== ``);

// The row's one name: the author, except an agent's commit that knows who it was for, where "for Ada" tells the rows
// apart and "intentic" on each would not. A person who is the author already (settings name them) keeps their own.
export const rowAuthor = (commit: GitCommit): string => {
    const requester = requesterOf(commit);
    return commit.email === AGENT_EMAIL && requester !== undefined ? t(`gitHistoryTab.forPerson`, { name: requester }) : commit.author;
};

// The detail's people, each a name and its address: the author always, then who the work was for when that is known.
// The address is only beside a name, never repeated as one.
export interface CommitPerson {
    readonly label: string;
    readonly name: string;
    readonly email?: string;
}

export const commitPeople = (commit: GitCommit): CommitPerson[] => {
    const people: CommitPerson[] = [{ label: t(`gitHistoryTab.author`), name: commit.author, email: commit.email }];
    const requester = requesterOf(commit);
    if (requester === undefined) {
        return people;
    }
    const email = commit.requestedBy?.email;
    const label = t(`gitHistoryTab.requestedBy`);
    people.push(email === undefined || email === requester ? { label, name: requester } : { label, name: requester, email });
    return people;
};
