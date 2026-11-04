import type { CommitAttribution, GitPerson } from "@intentic/sandbox-contract/schemas/settings";

// Identity every daemon-authored commit carries; one source so history reads consistently across routes.
// Above the subsystems rather than inside git/, because seven of them commit as the agent (workspace, history,
// inventory, portability, conversations/land, scaffold, git) and a constant owned by one of them makes the others import it.
export const AGENT_GIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

// Where an agent's shell holds the name and address its own `git commit` signs with (git/attribution/commit-attribution.ts).
// shellEnvOf (capabilities/cli-env.ts) folds them into git's environment-borne config, at command scope: over the
// repo's and the global config, so a stale `user.name` in a repository's config cannot sign for it, and under a `-c`
// the command passes itself, so a test that names its own author still gets that one.
export const AGENT_COMMIT_NAME = "INTENTIC_COMMIT_NAME";
export const AGENT_COMMIT_EMAIL = "INTENTIC_COMMIT_EMAIL";

// The trailer naming the conversation a daemon commit was made for. Every agent commit carries the one author above, so
// without it `git log` cannot say which conversation changed what; `git log --format='%(trailers:key=Conversation-Id)'`
// reads it back. Spelled once for every subsystem that commits on a conversation's behalf.
export const CONVERSATION_TRAILER = "Conversation-Id";

// A line git reads as a trailer: `Key: value`, the key one hyphenated word.
const TRAILER_LINE = /^[A-Za-z][\w-]*: \S/;

// Joins the message's own trailer paragraph when it ends with one, since git reads only the LAST paragraph as trailers:
// a second paragraph after `Allow:` or `Test-Note:` would hide them from `git log --format=%(trailers)`, which is how
// the push check and the assertion ratchet read them. A message of one paragraph is all subject, even one shaped
// `Agent: title`, so the trailers always open a paragraph of their own there. A line the message already carries is
// not added twice.
export const withTrailers = (message: string, trailers: readonly string[]): string => {
    const body = message.trimEnd();
    const fresh = [...new Set(trailers)].filter((trailer) => !body.split("\n").includes(trailer));
    if (fresh.length === 0) {
        return message;
    }
    const paragraphs = body.split("\n\n");
    const last = paragraphs.at(-1) ?? "";
    const endsWithTrailers = paragraphs.length > 1 && last.split("\n").every((line) => TRAILER_LINE.test(line));
    return `${body}${endsWithTrailers ? "\n" : "\n\n"}${fresh.join("\n")}`;
};

export const conversationTrailer = (conversationId: string): string => `${CONVERSATION_TRAILER}: ${conversationId}`;

export const withConversationTrailer = (message: string, conversationId: string): string => withTrailers(message, [conversationTrailer(conversationId)]);

// Who signs a daemon commit: `name`/`email` commit it, and author it too unless `author` names someone else (git's
// `author.*` config, which outranks `user.*` for the author alone).
export interface CommitSigner {
    readonly name: string;
    readonly email: string;
    readonly author?: GitPerson;
}

// What a commit carries for the person behind it, under the sandbox's `commitAttribution`: who signs it, and the
// trailer lines its message gains.
export interface Attribution {
    readonly signer: CommitSigner;
    readonly trailers: readonly string[];
}

// Names nobody: the agent signs it, and no line names a person. What every commit was before attribution.
export const UNATTRIBUTED: Attribution = { signer: AGENT_GIT_AUTHOR, trailers: [] };

// GitHub and GitLab both draw this trailer as a co-author on the commit, linked to the account the address belongs to.
export const CO_AUTHOR_TRAILER = "Co-authored-by";

// How one person goes into a commit under the owner's policy; nobody, when they set no commit identity of their own.
export const attributionOf = (policy: CommitAttribution, person: GitPerson | undefined): Attribution => {
    if (person === undefined || policy === "intentic") {
        return UNATTRIBUTED;
    }
    if (policy === "person") {
        return { signer: { ...AGENT_GIT_AUTHOR, author: person }, trailers: [] };
    }
    return { signer: AGENT_GIT_AUTHOR, trailers: [`${CO_AUTHOR_TRAILER}: ${person.name} <${person.email}>`] };
};
