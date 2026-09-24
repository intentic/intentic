import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extensionRuntimeDir } from "@intentic/sandbox-contract";

// Per-account resume state: highest UID dispatched for one capability's watched mailbox, persisted so mail from
// downtime is recovered on reconnect. uidValidity is a string because imapflow reports it as a bigint, which JSON can't
// hold.
export interface Watermark {
    readonly mailbox: string;
    readonly uidValidity: string;
    readonly lastUid: number;
}

// Plain node:fs under the workspace (extensions can't import daemon internals); the layout comes from the contract's
// extensionRuntimeDir. Capability id characters are sanitized to a safe filename.
export const watermarkPath = (workspaceRoot: string, capabilityId: string): string =>
    join(workspaceRoot, extensionRuntimeDir("imap"), `${capabilityId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);

// A missing file reads as no watermark, and so does a corrupt one, which is reported through `onUnreadable`: either way
// the caller re-baselines rather than replay history. A read that failed throws, since the baseline would overwrite it.
export const readWatermark = async (path: string, onUnreadable: (detail: string) => void): Promise<Watermark | undefined> => {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        onUnreadable(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
        onUnreadable("not a watermark: the file holds no object");
        return undefined;
    }
    const { mailbox, uidValidity, lastUid } = parsed as Record<string, unknown>;
    if (typeof mailbox !== "string" || typeof uidValidity !== "string" || typeof lastUid !== "number") {
        onUnreadable("not a watermark: mailbox, uidValidity or lastUid is missing or mistyped");
        return undefined;
    }
    return { mailbox, uidValidity, lastUid };
};

// Written beside and renamed over, so a crash mid-write leaves the previous mark rather than a torn one.
export const writeWatermark = async (path: string, mark: Watermark): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const staged = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(staged, JSON.stringify(mark));
    await rename(staged, path);
};

// Resume point for a freshly opened mailbox: a UIDVALIDITY change or a changed watched mailbox re-baselines to the
// current end and dispatches nothing. uidNext is the server's next-to-assign UID at open time.
export const resumePoint = (
    stored: Watermark | undefined,
    current: { mailbox: string; uidValidity: string; uidNext: number },
): { lastUid: number; baselined: boolean } => {
    if (stored === undefined || stored.mailbox !== current.mailbox || stored.uidValidity !== current.uidValidity) {
        return { lastUid: current.uidNext - 1, baselined: true };
    }
    return { lastUid: stored.lastUid, baselined: false };
};
