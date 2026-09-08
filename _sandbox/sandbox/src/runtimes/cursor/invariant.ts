import { readFile } from "node:fs/promises";
import { request } from "node:http";
import type { InvariantCheck } from "../../invariants/invariants.js";
import type { CursorHookService } from "./cursor-hooks.js";

// Checks that the boot-time chain (hooks file names the gate script, script names a socket, daemon listens on it) still
// holds: another daemon on the same /etc and auth root can rewrite any link after ready(). The listener can't be read
// off disk (a re-bound socket looks identical), so it's asked directly over /identity.

export interface CommandGateDeps {
    readonly cursorHooks: CursorHookService;
    // Overridden by tests; production reads the real files and asks the real socket.
    readonly readText?: (path: string) => Promise<string | undefined>;
    readonly listenerPid?: (socketPath: string) => Promise<number | undefined>;
    readonly pid?: number;
}

const readOrAbsent = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

// Who answers on the socket; any failure (nobody listening, or not the gate) resolves undefined.
const askListener = (socketPath: string): Promise<number | undefined> =>
    new Promise((resolve) => {
        const call = request({ socketPath, path: "/identity", method: "POST" }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", () => resolve(undefined));
            response.on("end", () => {
                try {
                    const answer: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    resolve(
                        typeof answer === "object" && answer !== null && "pid" in answer && typeof answer.pid === "number" ? answer.pid : undefined,
                    );
                } catch {
                    resolve(undefined);
                }
            });
        });
        call.on("error", () => resolve(undefined));
        call.end();
    });

export const owner = "cursor";

export const checks = ({
    cursorHooks,
    readText = readOrAbsent,
    listenerPid = askListener,
    pid = process.pid,
}: CommandGateDeps): readonly InvariantCheck[] => [
    {
        name: "command-gate-leads-to-this-daemon",
        // Not boot: the gate starts as its own best-effort boot job, after the boot moment has passed.
        on: ["sweep"],
        run: async ({ fail }) => {
            if (!cursorHooks.ready()) {
                return;
            }
            const { socket, script, hooks } = cursorHooks.paths();
            const hooksBody = await readText(hooks);
            if (hooksBody === undefined) {
                // Never installed (no /etc write access, already reported by start()); no chain to walk, already
                // unenforced.
                return;
            }
            if (!hooksBody.includes(script)) {
                return fail(
                    `Cursor's hooks file (${hooks}) no longer names this daemon's gate script (${script}): another daemon has taken the hook, and every Cursor turn here runs with the owner's command rulebook unenforced while reporting it in force`,
                );
            }
            const scriptBody = await readText(script);
            if (scriptBody === undefined || !scriptBody.includes(socket)) {
                return fail(
                    `the command-gate script (${script}) no longer names this daemon's socket (${socket}): Cursor's consults about this daemon's turns reach a daemon that has none registered, which allows them`,
                );
            }
            const listener = await listenerPid(socket);
            if (listener !== pid) {
                fail(
                    `the command-gate socket (${socket}) is answered by ${listener === undefined ? "nobody" : `pid ${listener}`}, not this daemon (pid ${pid}): a second daemon on this auth root has re-bound it, and consults about this daemon's turns reach one that has no such turn and allows them`,
                );
            }
        },
    },
];
