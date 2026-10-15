import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askHandover, HANDOVER_FRESH_MS, handoverAsked } from "./handover.js";

/* At a sign-in the signed-in session's agent takes over from the one the PC started before anyone did (2026-10-15). The
   boot agent leaves on its own when asked; one that does not is stopped, and a request nobody is waiting on any more is
   never obeyed, or the next boot agent would leave the moment it started. */

const fresh = (): string => join(mkdtempSync(join(tmpdir(), "handover-")), "handover.json");

describe("handoverAsked", () => {
    it("is asked by a live agent that wrote a request just now", async () => {
        const path = fresh();
        writeFileSync(path, JSON.stringify({ pid: 4242, at: 1_000 }));
        expect(await handoverAsked({ path, now: () => 1_000 + 5_000, alive: (pid) => pid === 4242 })).toBe(true);
    });

    it("is not asked by nobody, by an agent that has died, or by a request left long ago", async () => {
        const path = fresh();
        expect(await handoverAsked({ path, alive: () => true })).toBe(false);
        writeFileSync(path, JSON.stringify({ pid: 4242, at: 1_000 }));
        expect(await handoverAsked({ path, now: () => 2_000, alive: () => false })).toBe(false);
        expect(await handoverAsked({ path, now: () => 1_000 + HANDOVER_FRESH_MS, alive: () => true })).toBe(false);
    });

    it("reads a half-written request as no request yet", async () => {
        const path = fresh();
        writeFileSync(path, `{"pid": 42`);
        expect(await handoverAsked({ path, alive: () => true })).toBe(false);
    });
});

describe("askHandover", () => {
    it("waits for the holder to leave by itself, and stops nothing", async () => {
        const path = fresh();
        let polls = 0;
        const stopped: number[] = [];
        const ended = await askHandover(7, {
            path,
            pollMs: 5,
            waitMs: 1_000,
            // The boot agent reads the request at its next tick and releases the pidfile.
            holderNow: async () => await Promise.resolve((polls += 1) < 3 ? 7 : undefined),
            stop: async (pid) => void stopped.push(await Promise.resolve(pid)),
        });
        expect(ended).toBe("left");
        expect(stopped).toEqual([]);
        expect(existsSync(path)).toBe(false);
    });

    it("stops a holder that never leaves, and takes the request back", async () => {
        const path = fresh();
        const stopped: number[] = [];
        const ended = await askHandover(7, {
            path,
            pollMs: 5,
            waitMs: 40,
            holderNow: async () => await Promise.resolve(7),
            stop: async (pid) => void stopped.push(await Promise.resolve(pid)),
        });
        expect(ended).toBe("stopped");
        expect(stopped).toEqual([7]);
        expect(existsSync(path)).toBe(false);
    });

    it("writes a request the boot agent reads as asked while it waits", async () => {
        const path = fresh();
        let seen = false;
        await askHandover(7, {
            path,
            pollMs: 5,
            waitMs: 1_000,
            holderNow: async () => {
                seen = await handoverAsked({ path });
                return seen ? undefined : 7;
            },
            stop: async () => await Promise.resolve(),
        });
        expect(seen).toBe(true);
    });
});
