import { realpath, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

// What one window of the desktop app may touch, handed over by the app itself on this process's stdin and never by a
// page: a page only ever presents the token it was given, and the token decides the folder. A folder grant reads and
// writes inside its folder. A file grant (a document opened on its own) reads the folder the file is in, for the
// pictures and links a document points at beside it, and writes only that one file. A read-only grant writes nothing.
// A handoff grant is a file grant for pages the app does not serve (the web app at its own address): it answers only
// those pages, and only with the document's bytes.

export interface Grant {
    // The bearer the window's requests carry.
    readonly token: string;
    // Stable per window, the id the editor keys its state under (`local-<id>`).
    readonly id: string;
    // The real path of the folder served.
    readonly root: string;
    // For a file grant, the one root-relative file it may write; absent for a folder.
    readonly file?: string;
    // The folder's or the file's own name, for the page's title.
    readonly name: string;
    // Nothing may be written through it; absent means the grant's kind decides.
    readonly readOnly?: true;
    // A handoff grant's pages, by exact origin: the only ones it answers, and never the app's own.
    readonly origins?: readonly string[];
    // When the token stops opening anything, in milliseconds since the epoch; absent means when the app revokes it.
    readonly expiresAt?: number;
}

// What the app asks for: an absolute path it resolved from the user's own choice (a dialog, a drop, a double-click).
export interface GrantAsk {
    readonly token: string;
    readonly id: string;
    readonly path: string;
    readonly kind: `folder` | `file`;
    readonly readOnly?: boolean | undefined;
    readonly origins?: readonly string[] | undefined;
    readonly expiresInMs?: number | undefined;
}

// What a grant adds to the path it serves: its limits, each present only when the app asked for it.
interface GrantLimits {
    readOnly?: true;
    origins?: readonly string[];
    expiresAt?: number;
}

const limitsOf = (ask: GrantAsk, now: number): GrantLimits => {
    const limits: GrantLimits = {};
    if (ask.readOnly === true) {
        limits.readOnly = true;
    }
    if (ask.origins !== undefined) {
        limits.origins = [...ask.origins];
    }
    if (ask.expiresInMs !== undefined) {
        limits.expiresAt = now + ask.expiresInMs;
    }
    return limits;
};

// The grant an ask describes, or why it cannot be one. A file is granted where it really is: a link on the desktop to a
// document elsewhere serves the folder the document is in, not the desktop.
export const grantFor = async (ask: GrantAsk, now = Date.now()): Promise<Grant | { readonly error: string }> => {
    let real: string;
    try {
        real = await realpath(ask.path);
    } catch {
        return { error: `${ask.path} is not there` };
    }
    const found = await stat(real);
    if (ask.kind === `folder`) {
        if (ask.origins !== undefined) {
            return { error: `a grant for other pages hands over one document, not a folder` };
        }
        return found.isDirectory()
            ? { token: ask.token, id: ask.id, root: real, name: basename(real) || real, ...limitsOf(ask, now) }
            : { error: `${ask.path} is not a folder` };
    }
    if (!found.isFile()) {
        return { error: `${ask.path} is not a file` };
    }
    return { token: ask.token, id: ask.id, root: dirname(real), file: basename(real), name: basename(real), ...limitsOf(ask, now) };
};

// Why a window may not write: it writes nothing at all, or it opened one document and writes only that.
export const READ_ONLY = `This window was opened read-only.`;
export const ONE_DOCUMENT = `A document opened on its own can't change its folder.`;

// Whether a grant is a handoff: one for pages the app does not serve, answering only its document's bytes.
export const isHandoff = (grant: Grant): boolean => grant.origins !== undefined;

// Whether a grant lets its window write `path` (root-relative, already cleaned).
export const mayWrite = (grant: Grant, path: string): boolean =>
    grant.readOnly !== true && !isHandoff(grant) && (grant.file === undefined || grant.file === path);

// The live grants, by token. Replacing a token's grant is how the app re-points a window it reuses. A grant past its
// expiry ends the first time anything notices, a request or its own timer (channel.ts), and whoever listens hears it
// end the same way either way.
export class Grants {
    readonly #byToken = new Map<string, Grant>();
    readonly #expired = new Set<(grant: Grant) => void>();

    constructor(private readonly now: () => number = Date.now) {}

    // Serves `grant` under its token, answering the grant it takes the place of there, if one was.
    add(grant: Grant): Grant | undefined {
        const replaced = this.#byToken.get(grant.token);
        this.#byToken.set(grant.token, grant);
        return replaced;
    }

    // Stops serving whatever the token opens, answering what that was.
    revoke(token: string): Grant | undefined {
        const grant = this.#byToken.get(token);
        this.#byToken.delete(token);
        return grant;
    }

    // Hears each grant that ends at its expiry, until the returned function is called.
    onExpired(listener: (grant: Grant) => void): () => void {
        this.#expired.add(listener);
        return () => this.#expired.delete(listener);
    }

    // Ends `grant` when its time is up and it is still the one its token opens (a grant that replaced it is left
    // alone), telling every listener; whether it ended.
    expire(grant: Grant): boolean {
        if (this.#byToken.get(grant.token) !== grant || grant.expiresAt === undefined || this.now() < grant.expiresAt) {
            return false;
        }
        this.#byToken.delete(grant.token);
        for (const listener of this.#expired) {
            listener(grant);
        }
        return true;
    }

    byToken(token: string): Grant | undefined {
        const grant = this.#byToken.get(token);
        return grant === undefined || this.expire(grant) ? undefined : grant;
    }

    all(): readonly Grant[] {
        return [...this.#byToken.keys()].flatMap((token) => this.byToken(token) ?? []);
    }

    // Every origin a live handoff grant answers: the pages whose preflight may be let through before any token is seen.
    handoffOrigins(): ReadonlySet<string> {
        return new Set(this.all().flatMap((grant) => grant.origins ?? []));
    }
}
