import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GatewayCtx, ListenerMessage } from "@intentic/connector-runtime";
import { signInKey } from "./accounts.js";
import { SignInError } from "./auth.js";
import { type Graph, GraphError, type Page, query } from "./graph.js";

// New Outlook mail as listener events. Graph push needs a public HTTPS endpoint the sandbox does not have, so this polls
// the inbox's delta query once a minute. The first poll only records where the inbox stands, so connecting never
// replays old mail; the cursor is saved only after its batch was handed to the daemon, so a crash may deliver a
// message twice but never skips one.

export interface MailChange {
    id: string;
    subject?: string;
    bodyPreview?: string;
    receivedDateTime?: string;
    from?: { emailAddress?: { address?: string; name?: string } };
    toRecipients?: { emailAddress?: { address?: string } }[];
    "@removed"?: { reason?: string };
}

const POLL_MS = 60_000;
const FIELDS = "id,subject,bodyPreview,receivedDateTime,from,toRecipients";

export const deltaMail = async (graph: Graph, cursor: string | undefined, dispatch: (message: MailChange) => Promise<void>): Promise<string> => {
    let next: string | undefined = cursor ?? `/me/mailFolders/inbox/messages/delta?${query({ $select: FIELDS, changeType: "created" })}`;
    const visited = new Set<string>();
    while (next !== undefined) {
        if (visited.has(next)) {
            throw new Error("Graph delta pagination repeated a page");
        }
        visited.add(next);
        const page: Page<MailChange> = await graph.call(next);
        if (cursor !== undefined) {
            for (const message of page.value ?? []) {
                if (message["@removed"] === undefined) {
                    await dispatch(message);
                }
            }
        }
        if (page["@odata.deltaLink"] !== undefined) {
            return page["@odata.deltaLink"];
        }
        next = page["@odata.nextLink"];
    }
    throw new Error("Graph's delta answer carried no cursor");
};

// One cursor file per card and sign-in: a fresh sign-in may be someone else's mailbox, whose cursor this is not.
const cursorPath = (ctx: GatewayCtx, graph: Graph): string =>
    join(ctx.api.stateDir, `${Buffer.from(graph.account.id).toString("base64url")}-${signInKey(graph.account)}-mail.json`);

const readCursor = async (path: string): Promise<string | undefined> => {
    try {
        // SAFETY: only `saveCursor` writes this file; a cursor Graph no longer accepts answers 410 and re-baselines.
        return (JSON.parse(await readFile(path, "utf8")) as { cursor?: string }).cursor;
    } catch (error) {
        // SAFETY: a failed read from node:fs is a system error carrying `code`; anything else is rethrown unread.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
};

const saveCursor = async (path: string, cursor: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, JSON.stringify({ cursor }), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
};

const listenerMessage = (graph: Graph, own: string, message: MailChange): ListenerMessage => {
    const sender = message.from?.emailAddress;
    return {
        provider: "microsoft365",
        type: "mail",
        id: message.id,
        channelId: "inbox",
        author: { id: sender?.address ?? "", name: sender?.name ?? sender?.address ?? "" },
        content: `${message.subject ?? ""}\n\n${(message.bodyPreview ?? "").slice(0, 600)}`,
        timestamp: message.receivedDateTime ?? new Date().toISOString(),
        mentioned: message.toRecipients?.some((recipient) => recipient.emailAddress?.address?.toLowerCase() === own) ?? false,
        extra: { account: graph.account.id, messageId: message.id, subject: message.subject },
    };
};

export interface MailWatcher {
    readonly stop: () => void;
    readonly alive: () => boolean;
}

export const watchMail = async (ctx: GatewayCtx, graph: Graph, fatal: (detail: string) => void): Promise<MailWatcher> => {
    const path = cursorPath(ctx, graph);
    let cursor = await readCursor(path);
    // Fails the open on a sign-in Microsoft already refuses, rather than a watcher that finds out a minute later.
    const profile = await graph.call<{ mail?: string; userPrincipalName?: string }>("/me?$select=mail,userPrincipalName");
    const own = (profile.mail ?? profile.userPrincipalName ?? "").toLowerCase();
    let running = true;
    let polling = false;
    const poll = async (): Promise<void> => {
        if (!running || polling) {
            return;
        }
        polling = true;
        try {
            const next = await deltaMail(graph, cursor, async (message) => {
                if (running) {
                    await ctx.daemon.dispatch(listenerMessage(graph, own, message));
                }
            });
            await saveCursor(path, next);
            cursor = next;
        } catch (error) {
            if (error instanceof GraphError && error.status === 410) {
                cursor = undefined;
                ctx.log.warn({ account: graph.account.id }, "Outlook's mail cursor expired; the next poll starts from now");
            } else if (error instanceof SignInError || (error instanceof GraphError && (error.status === 401 || error.status === 403))) {
                running = false;
                fatal(error.message);
            } else {
                ctx.log.warn({ account: graph.account.id }, "Outlook mail poll failed; the cursor is kept for the next one");
            }
        } finally {
            polling = false;
        }
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    void poll();
    return {
        stop: () => {
            running = false;
            clearInterval(timer);
        },
        alive: () => running,
    };
};
