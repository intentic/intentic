import { appendFile, chmod, mkdir } from "node:fs/promises";
import { serialLock } from "@intentic/base/async";
import { rotateIfLarge } from "@intentic/local-agent";

// `audit.jsonl`: one JSON line per decision the keyring made, who asked for what and what it answered, so a person can
// read back every release, typing and refusal. Never a value: a record names entries, sandboxes, programs and reasons,
// and its fields are a closed list, so nothing a caller passes in reaches the file as free text but the grant's own
// `detail` and `conversation` (the sandbox's words for the use, shown in the prompt too). Rolled at 8 MiB, one
// rollover kept, as the local agents roll their logs.

export interface AuditRecord {
    readonly op: string;
    // "granted" handed out or typed a value, "refused" did not, "done" changed the vault, "pending" kept it for later.
    readonly outcome: "granted" | "refused" | "done" | "pending";
    readonly code?: string | undefined;
    readonly secret?: string | undefined;
    readonly sandbox?: string | undefined;
    readonly target?: string | undefined;
    readonly program?: string | undefined;
    readonly asked?: boolean | undefined;
    readonly how?: string | undefined;
    readonly detail?: string | undefined;
    readonly conversation?: string | undefined;
    readonly reason?: string | undefined;
}

export type Audit = (record: AuditRecord) => Promise<void>;

export const fileAudit = (path: string, dir: string, now: () => number = Date.now): Audit => {
    const queue = serialLock();
    return async (record) =>
        await queue(async () => {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await rotateIfLarge(path);
            await appendFile(path, `${JSON.stringify({ at: new Date(now()).toISOString(), ...record })}\n`, { mode: 0o600 });
            // appendFile's mode applies only to a file it creates; one rolled in by hand keeps whatever it had.
            await chmod(path, 0o600);
        });
};

// For a caller that keeps no record (a test that asserts on decisions some other way).
export const noAudit: Audit = () => Promise.resolve();
