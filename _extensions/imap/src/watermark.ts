import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// The per-account resume state: the highest UID already dispatched for one capability instance's watched
// mailbox. Persisted as a small JSON file so mail that arrived while the gateway (or the whole sandbox) was
// down is dispatched on reconnect instead of lost — the catch-up is the whole point of keeping it on disk.
// uidValidity is a string because imapflow reports it as a bigint, which JSON can't hold.
export interface Watermark {
    readonly mailbox: string;
    readonly uidValidity: string;
    readonly lastUid: number;
}

// Plain node:fs under the workspace (extensions can't import daemon internals); the discord gateway already
// writes this extensions-runtime tree. Capability ids are validated slugs, the replace is defense in depth.
export const watermarkPath = (workspaceRoot: string, capabilityId: string): string =>
    join(workspaceRoot, ".intentic", "extensions-runtime", "imap", `${capabilityId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);

// Missing or corrupt file reads as "no watermark" — the caller re-baselines; a broken file must never crash
// the gateway or replay history.
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

// Where to resume for a freshly opened mailbox. A UIDVALIDITY change means every stored UID is meaningless
// (the server renumbered), and a changed watched mailbox means the stored UIDs belong to another folder — both
// re-baseline at the current end of the mailbox and dispatch nothing, so a reset can never flood the agent
// with the whole mailbox history. `uidNext` is the server's next-to-assign UID at open time.
export const resumePoint = (
    stored: Watermark | undefined,
    current: { mailbox: string; uidValidity: string; uidNext: number },
): { lastUid: number; baselined: boolean } => {
    if (stored === undefined || stored.mailbox !== current.mailbox || stored.uidValidity !== current.uidValidity) {
        return { lastUid: current.uidNext - 1, baselined: true };
    }
    return { lastUid: stored.lastUid, baselined: false };
};
