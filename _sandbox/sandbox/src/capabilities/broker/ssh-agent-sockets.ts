import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { isConversationId } from "@intentic/sandbox-contract";
import { type SshAgentDeps, type SshPrincipal, serveSshAgent } from "./ssh-agent.js";

// Where the sandbox's ssh agent listens: one Unix socket for the owner's own terminal and one per conversation, all in
// one root-owned directory. The socket a process dials is who it is: SSH_AUTH_SOCK in a turn's environment names its
// conversation's socket, and the owner's terminal gets its own through the tmux server's environment. A conversation's
// socket is named by its id and a tag only the daemon's key can make, so the name cannot be guessed, and a background
// job still holding a socket's path after a daemon restart finds it listening again: every name bound is kept in a
// root-only list beside the sockets, which `start` re-opens (node removes a socket's file when its server closes, so
// the files themselves do not survive a graceful stop). The directory is the container's, so the list dies with the
// processes that could hold one of its paths.

// sun_path is 108 bytes with its terminating NUL; a longer path cannot be bound at all.
const MAX_SOCKET_PATH = 107;

const OWNER_SOCKET = "owner.sock";
// The conversation sockets bound so far, one name a line.
const BOUND_LIST = ".bound";
// A conversation's socket: `c-<id>.<tag>.sock`; one for a turn that runs in no conversation: `none.<tag>.sock`.
const CONVERSATION_SOCKET = /^c-([A-Za-z0-9][A-Za-z0-9_-]*)\.([A-Za-z0-9_-]+)\.sock$/u;
const NONE_SOCKET = /^none\.([A-Za-z0-9_-]+)\.sock$/u;

export interface SshAgentSockets {
    // The owner's socket, which only the daemon and the owner's terminal reach.
    readonly owner: string;
    // Binds the owner's socket and re-opens every conversation socket an earlier daemon run left behind.
    readonly start: () => Promise<void>;
    // The conversation's socket, bound on first ask; undefined (and logged) when it could not be bound, which leaves a
    // turn without SSH_AUTH_SOCK rather than failing it.
    readonly forConversation: (conversationId: string | undefined) => Promise<string | undefined>;
    // Closes and removes a conversation's socket (its purge).
    readonly forget: (conversationId: string) => Promise<void>;
    readonly stop: () => Promise<void>;
}

export interface SshAgentSocketsDeps extends SshAgentDeps {
    readonly dir: string;
    readonly tag: (purpose: string) => Promise<string>;
}

const purposeOf = (conversationId: string | undefined): string => `ssh-agent:${conversationId ?? ""}`;

export const createSshAgentSockets = (deps: SshAgentSocketsDeps): SshAgentSockets => {
    const listening = new Map<string, Promise<Server | undefined>>();
    const owner = join(deps.dir, OWNER_SOCKET);
    const listPath = join(deps.dir, BOUND_LIST);
    // Every conversation socket name to re-open after a restart; written whole, after each change.
    const bound = new Set<string>();
    let listWrite = Promise.resolve();
    const saveList = (): Promise<void> => {
        listWrite = listWrite
            .then(() => writeFileAtomic(listPath, [...bound].map((name) => `${name}\n`).join(""), 0o600))
            .catch((error: unknown) => deps.warn("ssh agent: the list of bound sockets could not be saved", error));
        return listWrite;
    };

    const nameFor = async (conversationId: string | undefined): Promise<string | undefined> => {
        if (conversationId !== undefined && !isConversationId(conversationId)) {
            return undefined;
        }
        const tag = await deps.tag(purposeOf(conversationId));
        return conversationId === undefined ? `none.${tag}.sock` : `c-${conversationId}.${tag}.sock`;
    };

    // Binds `name` once; a second ask while the first is binding waits on the same promise.
    const listen = (name: string, principal: SshPrincipal): Promise<Server | undefined> => {
        const existing = listening.get(name);
        if (existing !== undefined) {
            return existing;
        }
        const path = join(deps.dir, name);
        const binding = (async (): Promise<Server | undefined> => {
            if (path.length > MAX_SOCKET_PATH) {
                deps.warn(`ssh agent: ${path} is too long for a Unix socket, so this conversation gets no ssh agent`);
                return undefined;
            }
            // 0711: anyone may reach a socket whose name they hold, nobody but its owner may list the names. A directory
            // someone else made (in /tmp, before this daemon) could have its sockets swapped under it: refused.
            await mkdir(deps.dir, { recursive: true, mode: 0o711 });
            const made = await lstat(deps.dir);
            if (!made.isDirectory() || (process.getuid !== undefined && made.uid !== process.getuid())) {
                throw new Error(`${deps.dir} is not a directory this daemon's user owns`);
            }
            await chmod(deps.dir, 0o711);
            // A socket file outlives the server that bound it; a stale one would make listen fail with EADDRINUSE.
            await rm(path, { force: true });
            const server = createServer((socket) => serveSshAgent(socket, principal, deps));
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(path, () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            // Root-only until the agent runs as a user of its own, which is then the one this socket is handed to.
            await chmod(path, 0o600);
            if (principal.kind === "conversation" && !bound.has(name)) {
                bound.add(name);
                await saveList();
            }
            return server;
        })().catch((error: unknown) => {
            listening.delete(name);
            deps.warn(`ssh agent: could not listen on ${path}`, error);
            return undefined;
        });
        listening.set(name, binding);
        return binding;
    };

    const close = async (name: string): Promise<void> => {
        const server = await listening.get(name);
        listening.delete(name);
        if (server !== undefined) {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        }
        await rm(join(deps.dir, name), { force: true });
    };

    // A name this key made for a conversation (or for none), with whose it is; undefined for anything else.
    const verified = async (name: string): Promise<SshPrincipal | undefined> => {
        const conversation = CONVERSATION_SOCKET.exec(name);
        if (conversation === null && NONE_SOCKET.exec(name) === null) {
            return undefined;
        }
        const conversationId = conversation?.[1];
        return (await nameFor(conversationId)) === name ? { kind: "conversation", conversationId } : undefined;
    };

    return {
        owner,
        start: async () => {
            await listen(OWNER_SOCKET, { kind: "owner" });
            const saved = (await readFile(listPath, "utf8").catch(undefinedIfMissing)) ?? "";
            for (const name of saved.split("\n").filter((line) => line !== "")) {
                // Only a name this key made is re-opened; a line it cannot verify is dropped from the list.
                const principal = await verified(name);
                if (principal !== undefined) {
                    await listen(name, principal);
                }
            }
            await saveList();
        },
        forConversation: async (conversationId) => {
            const name = await nameFor(conversationId).catch((error: unknown) => {
                deps.warn("ssh agent: the socket name could not be made", error);
                return undefined;
            });
            if (name === undefined) {
                return undefined;
            }
            return (await listen(name, { kind: "conversation", conversationId })) === undefined ? undefined : join(deps.dir, name);
        },
        forget: async (conversationId) => {
            const name = await nameFor(conversationId).catch((error: unknown) => {
                deps.warn("ssh agent: a purged conversation's socket could not be named, so it stays bound until a restart", error);
                return undefined;
            });
            if (name !== undefined) {
                await close(name);
                bound.delete(name);
                await saveList();
            }
        },
        // Closes every socket but keeps the list, so the next daemon run re-opens what a background job may hold.
        stop: async () => {
            await Promise.all([...listening.keys()].map((name) => close(name)));
            await listWrite;
        },
    };
};
