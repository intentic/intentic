import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { agentHome } from "@intentic/local-agent";

// Where the keyring keeps its files and answers: `~/.intentic/keyring` (0700), and its pipe. On Windows a named pipe
// carrying a hash of the user's name, so two people on one computer never reach each other's keyring by accident; a
// unix socket inside the keyring's own directory elsewhere, whose 0700 parent is what keeps other users out.

export const KEYRING_HOME = "keyring";

export interface KeyringPaths {
    readonly dir: string;
    // The vault: entries sealed under the vault key, and the key wrapped for each way of unlocking (vault.ts).
    readonly vault: string;
    // The keys the keyring needs while locked: its `seal` key pair, and the sandboxes' pinned keys (keys.ts).
    readonly keys: string;
    // What happened, one JSON line per decision, never a value (audit.ts).
    readonly audit: string;
    readonly log: string;
    readonly pid: string;
    // The pipe or socket.
    readonly address: string;
}

// A short hash of this user's name: in the pipe's name, and in the Windows Hello credential's.
const userTag = (): string => createHash("sha256").update(userInfo().username.toLowerCase()).digest("hex").slice(0, 12);

export const keyringAddress = (dir: string, platform: NodeJS.Platform = process.platform): string =>
    platform === "win32" ? `\\\\.\\pipe\\intentic-keyring-${userTag()}` : join(dir, "keyring.sock");

export const keyringPaths = (dir: string = agentHome(KEYRING_HOME).dir, platform: NodeJS.Platform = process.platform): KeyringPaths => ({
    dir,
    vault: join(dir, "vault.json"),
    keys: join(dir, "keys.json"),
    audit: join(dir, "audit.jsonl"),
    log: join(dir, "keyring.log"),
    pid: join(dir, "keyring.pid"),
    address: keyringAddress(dir, platform),
});
