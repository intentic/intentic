import { isVaulted } from "@intentic/sandbox-contract/policy/capability-secrets";
import { type GitConnection, gitConnectionsFor, gitProviderName, gitUrlHost } from "@intentic/sandbox-contract/policy/git/git-connections";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";

// WHAT A PLUGIN OR EXTENSION INSTALL READS ITS REPOSITORY WITH. A token typed on its own card wins; without one, the
// GitHub or GitLab card connected for the repository's host lends its token, the one the card's git access already
// holds, so a private repository on an account the sandbox is signed in to needs nothing pasted twice. Read here, by the
// daemon, for the daemon's own clone: the agent's git goes through the credential gateway instead, and never sees it.
// Which card is the shared rule's (policy/git/git-connections.ts), so the form names the same one the clone uses.

export interface GitReader {
    readonly token?: string | undefined;
    // The card the token came from, when one did: what a refusal names.
    readonly connection?: GitConnection | undefined;
}

export interface GitSource {
    readonly url: string;
    readonly token?: string | undefined;
    // The card the install was set to read with, by id; absent picks the first match.
    readonly gitConnection?: string | undefined;
}

/** How a log line or a refusal names the card a read borrowed: `your GitHub connection "github-ada"`. */
export const connectionWords = (connection: GitConnection): string => `your ${gitProviderName(connection.provider)} connection "${connection.id}"`;

/** What an install's "Cloning …" line adds about its credential: the card it borrowed, else nothing. */
export const readerWords = (reader: GitReader): string => (reader.connection === undefined ? "" : ` with ${connectionWords(reader.connection)}`);

export class GitConnectionError extends Error {}

/**
 * The credential an install reads `url` with. Throws when the card it was set to read with is gone or no longer
 * answers for that host, rather than reading anonymously and failing further from the cause.
 */
export const gitReaderFor = async (capabilities: { readonly list: () => Promise<readonly Capability[]> }, source: GitSource): Promise<GitReader> => {
    if (source.token !== undefined) {
        return { token: source.token };
    }
    if (gitUrlHost(source.url) === undefined && source.gitConnection === undefined) {
        return {};
    }
    const cards = (await capabilities.list()).flatMap((capability) => (capability.kind === "cli" ? [capability] : []));
    const matches = gitConnectionsFor(cards, source.url);
    const chosen = source.gitConnection === undefined ? matches[0] : matches.find((match) => match.id === source.gitConnection);
    if (chosen === undefined) {
        if (source.gitConnection === undefined) {
            return {};
        }
        throw new GitConnectionError(
            `the connection "${source.gitConnection}" this was set to read ${source.url} with is gone, or is no GitHub or GitLab connection for that host with git access on: choose another, or paste an access token under Advanced.`,
        );
    }
    const token = cards.find((card) => card.id === chosen.id)?.config["token"];
    if (token === undefined || token === "" || isVaulted(token)) {
        throw new GitConnectionError(`${connectionWords(chosen)} holds no token to read ${source.url} with: connect it again, or paste an access token under Advanced.`);
    }
    return { token, connection: chosen };
};
