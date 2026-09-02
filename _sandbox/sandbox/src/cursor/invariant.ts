import { readFile } from "node:fs/promises";
import { request } from "node:http";
import type { InvariantCheck } from "../invariants/invariants.js";
import type { CursorHookService } from "./cursor-hooks.js";

/* THE HOOK STILL LEADS TO THIS DAEMON, or Cursor's turns run with the rulebook off while saying it is on.
 *
 * cursor-hooks.ts earns the `rulebook: "hooks"` tier with a chain of three links, each written once at boot:
 * Cursor's machine-global hooks file names a gate script, the script names a Unix socket, and this daemon
 * listens on the socket. Every link is a path another daemon can rewrite after this one has said `ready`, and
 * a dev sandbox swapped in beside this one does exactly that, on the same /etc and the same auth root. From
 * then on every consult Cursor makes about this daemon's turns reaches a daemon that has no such turn
 * registered, and the script's failure posture, which is right for an owner's hand-run Cursor, answers
 * `allow`. Nothing notices: the server is still up, `ready()` is still true, the turn still reports its rules
 * in force, and the owner's command rulebook applies to nothing.
 *
 * The third link cannot be read off the filesystem: a re-bound socket path looks identical to the one this
 * process opened. So the socket is ASKED who is listening, over the one route the gate server carries for
 * exactly this question. A local socket this daemon created, costing nothing anyone would meter. */

export interface CommandGateDeps {
    readonly cursorHooks: CursorHookService;
    // Overridden by tests; production reads the real files and asks the real socket.
    readonly readText?: (path: string) => Promise<string | undefined>;
    readonly listenerPid?: (socketPath: string) => Promise<number | undefined>;
    readonly pid?: number;
}

const readOrAbsent = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

// Who answers on the socket. Any failure is `undefined`: nobody listening, or something that is not the gate.
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
        // Not boot: the gate starts as a best-effort boot job of its own, after the boot moment has passed.
        on: ["sweep"],
        run: async ({ fail }) => {
            if (!cursorHooks.ready()) {
                return;
            }
            const { socket, script, hooks } = cursorHooks.paths();
            const hooksBody = await readText(hooks);
            if (hooksBody === undefined) {
                // Never installed: a container without write access to /etc, which start() reported once. There
                // is no chain to walk, and the turn already says its rules are unenforced.
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
