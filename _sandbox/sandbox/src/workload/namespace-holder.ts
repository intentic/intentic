import type { NamespaceEntryReference } from "./namespace-entry.js";
import { forgetNamespaceEntry } from "./namespace-entry.js";

interface NamespaceOutput {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

// A structural process seam: fake-data tests exercise holder loss without spawning unshare or bubblewrap.
export interface NamespaceHolder {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly stdout: NamespaceOutput | null;
    readonly stderr: NamespaceOutput | null;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
    off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    off(event: "error", listener: (error: Error) => void): unknown;
}

// Installed as soon as the holder is spawned, BEFORE readiness. A release-only disposer must not end this lifetime;
// actual exit owns retirement. A failed registration never gives this holder ownership of another holder's entry.
export const namespaceHolderLifetime = (holder: NamespaceHolder, cleanup: () => void) => {
    let ended = false;
    let reference: NamespaceEntryReference | undefined;
    const end = (): void => {
        if (ended) { return; }
        ended = true;
        if (reference !== undefined) { forgetNamespaceEntry(reference); }
        cleanup();
    };
    holder.once("exit", end);
    holder.once("error", end);
    const assertLive = (): void => {
        if (ended || holder.exitCode !== null || holder.signalCode !== null) {
            throw new Error("namespace holder ended during setup");
        }
    };
    return {
        end,
        register: (issue: () => NamespaceEntryReference): NamespaceEntryReference => {
            assertLive();
            if (reference !== undefined) { throw new Error("namespace holder already has an entry"); }
            reference = issue();
            try { assertLive(); } catch (error) {
                forgetNamespaceEntry(reference);
                end();
                throw error;
            }
            return reference;
        },
    };
};

// Both mount-only and fenced anchors use this bounded handshake. A fenced anchor reports its inner PID on info-fd;
// the mount-only holder keeps its own PID. Neither a partial marker nor an invalid reported PID admits an entrant.
export const namespaceHolderReady = (
    holder: NamespaceHolder,
    marker: string,
    info?: NamespaceOutput | null,
): Promise<number> => new Promise((resolve, reject) => {
    if (holder.exitCode !== null || holder.signalCode !== null || holder.stdout === null || holder.stderr === null || info === null) {
        reject(new Error("namespace holder is not live with readiness streams"));
        return;
    }
    let settled = false;
    let partialLine = "";
    let discardLine = false;
    let stderr = "";
    let reported = "";
    let pid = info === undefined ? holder.pid : undefined;
    let ready = false;
    const finish = (error?: Error): void => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        holder.stdout?.off("data", onOutput);
        holder.stderr?.off("data", onStderr);
        info?.off("data", onInfo);
        holder.off("exit", onExit);
        holder.off("error", onError);
        if (error !== undefined) { reject(error); } else { resolve(pid!); }
    };
    const admit = (): void => {
        if (!ready || pid === undefined) { return; }
        if (!Number.isSafeInteger(pid) || pid <= 0) {
            finish(new Error("namespace holder reported an invalid PID"));
            return;
        }
        finish();
    };
    const onOutput = (bytes: Buffer): void => {
        const text = bytes.toString();
        let from = 0;
        for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", from)) {
            const line = text.slice(from, newline);
            ready ||= !discardLine && partialLine.length + line.length === marker.length && partialLine + line === marker;
            partialLine = "";
            discardLine = false;
            from = newline + 1;
        }
        // Keep at most a marker-length partial line. Discard an oversized line through its newline, rather than
        // truncating its prefix into a false marker or dropping a legitimate complete marker before parsing it.
        if (!discardLine) {
            const tail = text.slice(from);
            discardLine = partialLine.length + tail.length > marker.length;
            partialLine = discardLine ? "" : partialLine + tail;
        }
        admit();
    };
    const onStderr = (bytes: Buffer): void => { stderr = (stderr + bytes.toString()).slice(-8192); };
    const onInfo = (bytes: Buffer): void => {
        reported += bytes.toString();
        const match = /"child-pid"\s*:\s*(\d+)\s*[,}]/u.exec(reported);
        // Inspect complete records before bounding the incomplete suffix; later noise cannot erase a reported PID.
        reported = reported.slice(-8192);
        if (match?.[1] !== undefined && pid === undefined) { pid = Number(match[1]); }
        admit();
    };
    const onExit = (code: number | null): void => { finish(new Error(`namespace setup exited ${String(code)}: ${stderr.trim()}`)); };
    const onError = (error: Error): void => { finish(error); };
    const timer = setTimeout(() => { finish(new Error(`namespace setup timed out: ${stderr.trim()}`)); }, 10_000);
    holder.stdout.on("data", onOutput);
    holder.stderr.on("data", onStderr);
    info?.on("data", onInfo);
    holder.once("exit", onExit);
    holder.once("error", onError);
});
