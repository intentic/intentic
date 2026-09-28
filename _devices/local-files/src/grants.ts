import { realpath, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

// What one window of the desktop app may touch, handed over by the app itself on this process's stdin and never by a
// page: a page only ever presents the token it was given, and the token decides the folder. A folder grant reads and
// writes inside its folder. A file grant (a document opened on its own) reads the folder the file is in, for the
// pictures and links a document points at beside it, and writes only that one file.

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
}

// What the app asks for: an absolute path it resolved from the user's own choice (a dialog, a drop, a double-click).
export interface GrantAsk {
    readonly token: string;
    readonly id: string;
    readonly path: string;
    readonly kind: `folder` | `file`;
}

// The grant an ask describes, or why it cannot be one. A file is granted where it really is: a link on the desktop to a
// document elsewhere serves the folder the document is in, not the desktop.
export const grantFor = async (ask: GrantAsk): Promise<Grant | { readonly error: string }> => {
    let real: string;
    try {
        real = await realpath(ask.path);
    } catch {
        return { error: `${ask.path} is not there` };
    }
    const found = await stat(real);
    if (ask.kind === `folder`) {
        return found.isDirectory() ? { token: ask.token, id: ask.id, root: real, name: basename(real) || real } : { error: `${ask.path} is not a folder` };
    }
    if (!found.isFile()) {
        return { error: `${ask.path} is not a file` };
    }
    return { token: ask.token, id: ask.id, root: dirname(real), file: basename(real), name: basename(real) };
};

// Whether a grant lets its window write `path` (root-relative, already cleaned).
export const mayWrite = (grant: Grant, path: string): boolean => grant.file === undefined || grant.file === path;

// The live grants, by token. Replacing a token's grant is how the app re-points a window it reuses.
export class Grants {
    readonly #byToken = new Map<string, Grant>();

    add(grant: Grant): void {
        this.#byToken.set(grant.token, grant);
    }

    revoke(token: string): Grant | undefined {
        const grant = this.#byToken.get(token);
        this.#byToken.delete(token);
        return grant;
    }

    byToken(token: string): Grant | undefined {
        return this.#byToken.get(token);
    }

    all(): readonly Grant[] {
        return [...this.#byToken.values()];
    }
}
