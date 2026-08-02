import { describe, expect, it } from "vitest";
import { detachedSpawnOptions } from "./detached.js";

/* A local agent's background loop spawns child processes for its whole life — the sync watcher runs
 * git → ssh → cloudflared on every tick, the host agent runs whatever the sandbox's agent asked for. On Windows,
 * `detached` (DETACHED_PROCESS) leaves the loop with no console, and Windows then gives each of those children a
 * console of its own — a new console window, popping up and closing every five seconds on an idle machine.
 * windowsHide (CREATE_NO_WINDOW) gives the loop a console WITHOUT a window for them to inherit instead.
 *
 * Passing both is passing neither: CREATE_NO_WINDOW is ignored with DETACHED_PROCESS, which is how the popping
 * shipped. */
describe("detachedSpawnOptions", () => {
    it("gives Windows a windowless console and never detaches", () => {
        expect(detachedSpawnOptions("win32")).toEqual({ windowsHide: true });
    });

    it("detaches on POSIX, where a session — not a console — is what outlives the terminal", () => {
        expect(detachedSpawnOptions("linux")).toEqual({ detached: true });
        expect(detachedSpawnOptions("darwin")).toEqual({ detached: true });
    });
});
