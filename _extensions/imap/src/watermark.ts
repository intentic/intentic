import { mkdir, readFile, writeFile } from "node:fs/promises";
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

// Missing or corrupt file reads as no watermark; a broken file must never crash the gateway or replay history.
export const readWatermark = async (path: string): Promise<Watermark | undefined> => {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const mailbox = parsed["mailbox"];
        const uidValidity = parsed["uidValidity"];
        const lastUid = parsed["lastUid"];
        if (typeof mailbox !== "string" || typeof uidValidity !== "string" || typeof lastUid !== "number") {
            return undefined;
        }
        return { mailbox, uidValidity, lastUid };
    } catch {
        return undefined;
    }
};

export const writeWatermark = async (path: string, mark: Watermark): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(mark));
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
