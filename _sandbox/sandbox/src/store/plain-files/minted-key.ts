import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { SingleFlight } from "@intentic/base/async";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { syncDirectory, writeFileAtomic } from "@intentic/base/fs";

// A signing key the daemon mints once and keeps across restarts: the session secret, the privacy gateway's and the
// credential broker's address keys. One loader for all of them, because a key that changes under its holders signs
// everyone out or strands every address already handed out, and each of the three wrote its key its own way:
// - written whole or not at all: staged, flushed, then published, so a crash mid-write cannot leave a short file that
//   the next boot reads as "no key" and replaces
// - minted once: published with `link`, which fails if another writer got there first, and the winner's key is read
//   back rather than each writer keeping its own
// - root-only: 0600 on the file, enforced on a key an older build left more open, since a key an agent can read lets it
//   mint addresses for conversations not its own
// A file that exists but cannot be read is never replaced (the read throws), and neither is a valid key. Only absence,
// or content too short to be a key this build wrote, mints a new one.

export interface MintedKeyOptions {
    // Random bytes in a fresh key, and the least a stored one must decode to.
    readonly bytes?: number;
    // How the key sits on the disk: raw bytes, or base64url text (the session secret's spelling since it was first written).
    readonly encoding?: "raw" | "base64url";
}

const KEY_MODE = 0o600;
const DEFAULT_BYTES = 32;

const decode = (stored: Buffer, encoding: "raw" | "base64url"): Buffer =>
    encoding === "raw" ? stored : Buffer.from(stored.toString("utf8").trim(), "base64url");

const encode = (key: Buffer, encoding: "raw" | "base64url"): Buffer => (encoding === "raw" ? key : Buffer.from(key.toString("base64url")));

// Flushed before it is published: a power cut right after a plain write can leave the name pointing at nothing.
const stageKey = async (staging: string, content: Buffer): Promise<void> => {
    const handle = await open(staging, "wx", KEY_MODE);
    try {
        await handle.writeFile(content);
        await handle.sync();
    } finally {
        await handle.close();
    }
};

// Publishes a first key, or answers false when another writer already published one.
const publishFirst = async (path: string, content: Buffer): Promise<boolean> => {
    const staging = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await stageKey(staging, content);
        await link(staging, path);
        await syncDirectory(dirname(path));
        return true;
    } catch (error) {
        if (errnoCode(error) === "EEXIST") {
            return false;
        }
        throw error;
    } finally {
        await rm(staging, { force: true });
    }
};

// A key left readable by others by an older build that wrote it with the umask's mode: closed down, never re-minted.
const holdMode = async (path: string): Promise<void> => {
    const { mode } = await stat(path);
    if ((mode & 0o077) !== 0) {
        await chmod(path, KEY_MODE);
    }
};

const readValid = async (path: string, bytes: number, encoding: "raw" | "base64url"): Promise<Buffer | undefined> => {
    const stored = await readFile(path).catch(undefinedIfMissing);
    if (stored === undefined) {
        return undefined;
    }
    const key = decode(stored, encoding);
    return key.length >= bytes ? key : undefined;
};

const mintAt = async (path: string, bytes: number, encoding: "raw" | "base64url"): Promise<Buffer> => {
    const existing = await readValid(path, bytes, encoding);
    if (existing !== undefined) {
        await holdMode(path);
        return existing;
    }
    await mkdir(dirname(path), { recursive: true });
    const minted = randomBytes(bytes);
    const present = (await stat(path).catch(undefinedIfMissing)) !== undefined;
    if (!present) {
        if (await publishFirst(path, encode(minted, encoding))) {
            return minted;
        }
        // Another writer published first: its key is the key. One too short to use is damage, replaced below.
        const winner = await readValid(path, bytes, encoding);
        if (winner !== undefined) {
            await holdMode(path);
            return winner;
        }
    }
    // Content too short to be a key: damage from outside or a torn write by a build before this loader. Replaced
    // whole, and what is then on the disk is what this answers, so a reader never holds a key that was not kept.
    await writeFileAtomic(path, encode(minted, encoding), KEY_MODE, { durable: true });
    const kept = await readValid(path, bytes, encoding);
    if (kept === undefined) {
        throw new Error(`the key at ${path} could not be read back after it was written`);
    }
    return kept;
};

// One mint per path in this process, so two holders of one key file asking at once share one answer.
const minting = new SingleFlight<string, Buffer>();

// The key at `path`, minted on first use. Throws when the file exists but cannot be read, rather than replace a key
// its holders still sign with.
export const loadOrMintKey = (path: string, options: MintedKeyOptions = {}): Promise<Buffer> =>
    minting.run(path, () => mintAt(path, options.bytes ?? DEFAULT_BYTES, options.encoding ?? "raw"));
