import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import { isMissing } from "@intentic/base/errors";
import { type AuditEvent, AuditEventSchema } from "@intentic/sandbox-contract/schemas/audit";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { fileOwnerStore, OwnerUnreadableError, ownerDocument } from "../auth.js";
import { fileBrowserAccess } from "../browser-access.js";
import { createSessions, type MintedSession } from "../session.js";

/* A SESSION FROM THE MACHINE THAT RUNS THE SANDBOX (`ic sandbox session <slug>`).

The desktop app and Intentic OS reach this machine's own sandboxes over the loopback port with no network at all, which
none of the other proofs survive: Google's keys, the platform's ticket and its identity assertion are all fetched, and a
passkey answers only on the editor origin it was registered on. What such a machine still has is the machine: whoever
can `docker exec` into this container is root over it already (they can read every file, the session secret included),
so a session minted for them adds no power they lack.

TRUST MODEL, spelled out because this is the one proof the daemon takes without a third party:
- It is reachable only from inside the container, as root: `host-session-cli.js` reads the 0600 session secret and the
  owner file directly. There is NO HTTP route that mints one, and an agent turn in the unprivileged execution domain
  (workload/domain) runs as another user and cannot read either file.
- It mints for the BOUND owner only, and refuses while nobody is bound: the first binding still takes a real sign-in
  with the connect token, so possession of the machine never decides who owns a sandbox it holds.
- The session is an ordinary daemon session (session.ts), proven by `host`: every request is still authorized per
  request against the owner file and the roster (auth.ts), so moving the owner or signing out everywhere (which re-keys
  the secret) ends it like any other.
- Each mint is recorded in the audit trail as a sign-in by `host`. The trail has one writer, the daemon, so this leaves
  a note in `audit/inbox/` that the daemon's audit tick records (`drainAuditInbox`) and deletes. */

// Where events written outside the daemon wait for its audit tick. Root-only, like the trail itself.
export const AUDIT_INBOX_DIR = "audit/inbox";

// What `node /opt/sandbox/dist/auth/host/host-session-cli.js` prints on stdout, one line: the session and whom it is for.
export const HostSessionAnswerSchema = z.object({
    email: z.string(),
    token: z.string(),
    expiresAt: z.number(),
    // The platform's own id for this sandbox, when an announce told the daemon one (platform-row.ts); null before.
    platformId: z.string().nullable(),
});
export type HostSessionAnswer = z.infer<typeof HostSessionAnswerSchema>;

// Why no session was minted, as the CLI's exit code says it, so `ic` can tell a sandbox nobody has bound yet (which a
// person fixes by signing in once) from one whose files cannot be read (which `ic sandbox reset-owner` is for).
export const HOST_SESSION_EXIT = { noOwner: 3, ownerUnreadable: 4, browserAccessRemoved: 5 } as const;

export class HostSessionRefused extends Error {
    readonly code: number;
    constructor(code: number, message: string) {
        super(message);
        this.name = "HostSessionRefused";
        this.code = code;
    }
}

export interface HostSessionDeps {
    readonly historyRoot: string;
    readonly now?: () => number;
    // The platform's id for this sandbox, read where the announcer keeps it.
    readonly platformId?: () => Promise<string | undefined>;
}

// The note `drainAuditInbox` records: the owner signed in through the machine. Never the token.
// `mintedAt` because the record itself is stamped when the daemon's tick takes the note, up to a minute later.
const hostSignIn = (email: string, at: number): AuditEvent => ({
    actor: { kind: "member", email: email.toLowerCase(), role: "owner" },
    action: "auth.sign_in",
    details: { methods: ["host"], mintedAt: at },
});

// Written whole under a name of its own, so the daemon never reads half of one and two mints never collide.
const leaveAuditNote = async (historyRoot: string, event: AuditEvent, now: number): Promise<void> => {
    const dir = join(historyRoot, AUDIT_INBOX_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, `${String(now)}-${randomBytes(6).toString("hex")}.json`), JSON.stringify(event), 0o600);
};

// Mints a session for the bound owner, proven by `host`, and leaves its audit note. Throws HostSessionRefused when
// there is nobody to mint for.
export const mintHostSession = async (deps: HostSessionDeps): Promise<HostSessionAnswer> => {
    const now = deps.now ?? Date.now;
    let owner: string | undefined;
    try {
        owner = await fileOwnerStore(join(deps.historyRoot, ownerDocument.path)).read();
    } catch (error) {
        if (error instanceof OwnerUnreadableError) {
            throw new HostSessionRefused(HOST_SESSION_EXIT.ownerUnreadable, `${error.message}; \`ic sandbox reset-owner\` moves it aside`);
        }
        throw error;
    }
    if (owner === undefined) {
        throw new HostSessionRefused(
            HOST_SESSION_EXIT.noOwner,
            "nobody has signed in to this sandbox yet: its owner signs in once, with the internet, before this computer can open it on its own",
        );
    }
    // Retired for good when its account was deleted (browser-access.ts): every bearer is refused, so this mints none.
    if (!(await fileBrowserAccess(join(deps.historyRoot, "browser-access-disabled")).enabled())) {
        throw new HostSessionRefused(HOST_SESSION_EXIT.browserAccessRemoved, "browser access to this sandbox has been removed");
    }
    const minted: MintedSession = await createSessions(join(deps.historyRoot, "session-secret")).mint({ email: owner, methods: ["host"] });
    const at = now();
    await leaveAuditNote(deps.historyRoot, hostSignIn(owner, at), at);
    return { email: owner, token: minted.token, expiresAt: minted.expiresAt, platformId: (await deps.platformId?.()) ?? null };
};

// Records every note waiting in the inbox, oldest first, and deletes each once it is queued. A note that is not an
// event (a half-written file cannot be one: they are renamed into place) is deleted with a warning, never recorded.
export const drainAuditInbox = async (
    historyRoot: string,
    record: (event: AuditEvent) => void,
    warn: (message: string, error?: Error) => void,
): Promise<number> => {
    const dir = join(historyRoot, AUDIT_INBOX_DIR);
    let names: string[];
    try {
        names = (await readdir(dir)).filter((name) => name.endsWith(".json")).toSorted();
    } catch (error) {
        if (isMissing(error)) {
            return 0;
        }
        throw error;
    }
    let recorded = 0;
    for (const name of names) {
        const path = join(dir, name);
        const event = parseJsonWith(await readFile(path, "utf8"), AuditEventSchema);
        if (event === undefined) {
            warn(`audit: ${name} in the inbox is not an audit event; deleted unrecorded`);
        } else {
            record(event);
            recorded += 1;
        }
        await rm(path, { force: true });
    }
    return recorded;
};
