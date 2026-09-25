import { createHash, randomBytes } from "node:crypto";

// Editor sessions: a token the editor page is opened with, and the document key ONLYOFFICE Docs files the document
// under. The key rule is what makes co-editing and saving right: one key per file content, so two tabs on one file share
// a session, and a file changed on disk by someone else gets a new key so the next open starts from the new bytes.
//
// A key also has an end. Once the document server has handed back the final save of a session (every editor closed),
// it holds that key as outdated: an open under it within five minutes gets "Version changed", and after that the
// conversion it cached at the session's START, without the edits. So a closed key is retired and never handed out again.

export interface FileStat {
    readonly size: number;
    readonly mtimeMs: number;
}

export interface Session {
    readonly token: string;
    readonly key: string;
    readonly path: string;
    // The conversation whose checkout the file is read from; such a session is view-only.
    readonly agent: string | undefined;
    readonly mode: "edit" | "view";
    readonly theme: "light" | "dark";
    readonly expiresAt: number;
    // Which run of the document server the session was opened against. A server that restarted since holds none of
    // the session's state, so an editor kept alive from before it is not one to show again.
    readonly run: number;
}

export interface OpenInput {
    readonly path: string;
    readonly agent: string | undefined;
    readonly mode: "edit" | "view";
    readonly theme: "light" | "dark";
    // The file as it stands at open, for the shared tree.
    readonly stat: FileStat | undefined;
    // A conversation's copy has no stat here: the digest of its bytes stands in, so reopening the same bytes finds the
    // conversion the server already made. Without one, the copy is keyed fresh every open.
    readonly digest?: string | undefined;
    readonly run?: number;
}

// What a key names: where the document is read from and, for the shared tree, the content the key stands for.
interface Document {
    readonly path: string;
    readonly agent: string | undefined;
    readonly stat: FileStat | undefined;
    // The file as this key's own save left it, so a re-open after that save keeps the key.
    savedStat: FileStat | undefined;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const sameStat = (a: FileStat | undefined, b: FileStat | undefined): boolean =>
    a !== undefined && b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs;

// Within ONLYOFFICE's key alphabet ([0-9a-zA-Z._=-], up to 128 chars).
const keyOf = (...parts: string[]): string => createHash("sha256").update(parts.join(" ")).digest("base64url");

export class Sessions {
    private readonly byToken = new Map<string, Session>();
    private readonly byKey = new Map<string, Document>();
    // The key currently standing for a shared-tree path.
    private readonly currentKey = new Map<string, string>();
    // Keys whose session the server closed with a final save; see the header.
    private readonly retired = new Set<string>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    open(input: OpenInput): Session {
        this.sweep();
        const session: Session = {
            token: randomBytes(24).toString("base64url"),
            key: this.keyFor(input),
            path: input.path,
            agent: input.agent,
            mode: input.mode,
            theme: input.theme,
            expiresAt: this.now() + SESSION_TTL_MS,
            run: input.run ?? 0,
        };
        this.byToken.set(session.token, session);
        return session;
    }

    session(token: string): Session | undefined {
        const found = this.byToken.get(token);
        if (found === undefined) {
            return undefined;
        }
        if (found.expiresAt <= this.now()) {
            this.byToken.delete(token);
            return undefined;
        }
        return found;
    }

    // Whether the editor running under `token` still holds the document an open with `input` would get, so a frame kept
    // alive since can be shown again instead of loading a new one. Registers nothing.
    current(token: string, input: OpenInput): boolean {
        const found = this.session(token);
        if (found === undefined || found.path !== input.path || found.agent !== input.agent || found.mode !== input.mode) {
            return false;
        }
        return found.run === (input.run ?? 0) && found.key === this.candidate(input);
    }

    // Moves a live session onto a new key, for an editor the server told its key is outdated: that key is retired here too,
    // whatever this side knew of it, so the editor is never sent back to the key it was just turned away from.
    renew(token: string, input: OpenInput): Session | undefined {
        const found = this.session(token);
        if (found === undefined) {
            return undefined;
        }
        this.closed(found.key);
        const renewed: Session = { ...found, key: this.keyFor(input), run: input.run ?? found.run };
        this.byToken.set(token, renewed);
        return renewed;
    }

    document(key: string): { path: string; agent: string | undefined } | undefined {
        const found = this.byKey.get(key);
        return found === undefined ? undefined : { path: found.path, agent: found.agent };
    }

    // A forced save (Ctrl+S, or the viewer's own on leaving) under `key` left the file as `stat`. The session goes on,
    // so the next open of those bytes joins it rather than forking a second session over one file.
    saved(key: string, stat: FileStat): void {
        const found = this.byKey.get(key);
        if (found !== undefined) {
            found.savedStat = stat;
        }
    }

    // The server closed the session under `key` with its final save: the next open starts a new session, even over the
    // very same bytes.
    closed(key: string): void {
        const found = this.byKey.get(key);
        if (found === undefined) {
            return;
        }
        this.retired.add(key);
        if (this.currentKey.get(found.path) === key) {
            this.currentKey.delete(found.path);
        }
    }

    // The key an open with `input` gets, without registering it; undefined for a copy keyed fresh every open.
    private candidate(input: OpenInput): string | undefined {
        if (input.agent !== undefined || input.stat === undefined) {
            return input.digest === undefined ? undefined : this.unretired(input.path, input.agent ?? "", input.digest);
        }
        return this.sharedKey(input.path, input.stat);
    }

    // The shared tree's key for `path` at `stat`: the current one while the file is as it opened or as the key's own save
    // left it, else the one for these bytes.
    private sharedKey(path: string, stat: FileStat): string {
        const current = this.currentKey.get(path);
        const known = current === undefined ? undefined : this.byKey.get(current);
        if (current !== undefined && known !== undefined && (sameStat(known.stat, stat) || sameStat(known.savedStat, stat))) {
            return current;
        }
        return this.unretired(path, String(stat.size), String(stat.mtimeMs));
    }

    private keyFor(input: OpenInput): string {
        if (input.agent !== undefined || input.stat === undefined) {
            // A scoped copy: never saved back, so nothing to track beyond where its bytes are read from.
            const key = this.candidate(input) ?? keyOf(input.path, input.agent ?? "", randomBytes(8).toString("hex"));
            this.byKey.set(key, { path: input.path, agent: input.agent, stat: undefined, savedStat: undefined });
            return key;
        }
        const key = this.sharedKey(input.path, input.stat);
        if (this.currentKey.get(input.path) !== key) {
            this.byKey.set(key, { path: input.path, agent: undefined, stat: input.stat, savedStat: undefined });
            this.currentKey.set(input.path, key);
        }
        return key;
    }

    // The key for these parts, stepped past any retired one: deterministic, so a restarted backend lands on the key the
    // server already converted, and never one the server holds as outdated.
    private unretired(...parts: string[]): string {
        let key = keyOf(...parts);
        for (let generation = 1; this.retired.has(key); generation++) {
            key = keyOf(...parts, String(generation));
        }
        return key;
    }

    private sweep(): void {
        const now = this.now();
        for (const [token, session] of this.byToken) {
            if (session.expiresAt <= now) {
                this.byToken.delete(token);
            }
        }
    }
}
