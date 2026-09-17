import { createHash, randomBytes } from "node:crypto";

// Editor sessions: a token the editor page is opened with, and the document key ONLYOFFICE Docs files the document
// under. The key rule is what makes co-editing and saving right: one key per file content, so two tabs on one file share
// a session, and a file changed on disk by someone else gets a new key so the next open starts from the new bytes.

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
}

export interface OpenInput {
    readonly path: string;
    readonly agent: string | undefined;
    readonly mode: "edit" | "view";
    readonly theme: "light" | "dark";
    // The file as it stands at open; undefined for a scoped copy, which is never written and needs no key sharing.
    readonly stat: FileStat | undefined;
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

    document(key: string): { path: string; agent: string | undefined } | undefined {
        const found = this.byKey.get(key);
        return found === undefined ? undefined : { path: found.path, agent: found.agent };
    }

    // Records that a save under `key` left the file as `stat`, so the next open of the same bytes reuses the key.
    saved(key: string, stat: FileStat): void {
        const found = this.byKey.get(key);
        if (found !== undefined) {
            found.savedStat = stat;
        }
    }

    private keyFor(input: OpenInput): string {
        if (input.agent !== undefined || input.stat === undefined) {
            // A scoped copy: fresh every open, nothing to share and nothing to save back.
            const key = keyOf(input.path, input.agent ?? "", randomBytes(8).toString("hex"));
            this.byKey.set(key, { path: input.path, agent: input.agent, stat: undefined, savedStat: undefined });
            return key;
        }
        const current = this.currentKey.get(input.path);
        const known = current === undefined ? undefined : this.byKey.get(current);
        if (current !== undefined && known !== undefined && (sameStat(known.stat, input.stat) || sameStat(known.savedStat, input.stat))) {
            return current;
        }
        const key = keyOf(input.path, String(input.stat.size), String(input.stat.mtimeMs));
        this.byKey.set(key, { path: input.path, agent: undefined, stat: input.stat, savedStat: undefined });
        this.currentKey.set(input.path, key);
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
