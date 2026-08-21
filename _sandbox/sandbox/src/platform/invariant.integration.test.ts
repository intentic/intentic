import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { checks } from "./invariant.js";

/* 2026-07-31, from the survivor's side. A second daemon booted, took the claim, converged HOME onto its own
 * roots, and the daemon that had been running went on believing the answer it got at ITS boot: converging,
 * sweeping and announcing on the strength of a file that no longer named it, with nothing anywhere saying so. */

const fail = (message: string): never => {
    throw new Error(message);
};

const ROOTS = { workspaceRoot: "/work", historyRoot: "/history" };
const homes: string[] = [];

afterEach(() => {
    for (const home of homes.splice(0)) {
        rmSync(home, { recursive: true, force: true });
    }
});

const homeWith = (claim?: { pid: number }): string => {
    const home = mkdtempSync(join(tmpdir(), "claim-"));
    homes.push(home);
    if (claim !== undefined) {
        writeFileSync(join(home, ".intentic-daemon.json"), JSON.stringify({ ...claim, ...ROOTS }));
    }
    return home;
};

const run = (role: { container: boolean; roots: boolean }, home: string, pid: number): void => {
    const [check] = checks({ role, roots: ROOTS, home, pid });
    check?.run({ moment: "sweep", fail });
};

test("the holder still naming this process reports nothing", () => {
    expect(() => run({ container: true, roots: true }, homeWith({ pid: 4242 }), 4242)).not.toThrow();
});

test("the claim taken by another daemon is reported, with the pid that took it", () => {
    expect(() => run({ container: true, roots: true }, homeWith({ pid: 9001 }), 4242)).toThrow(/claim now names pid 9001/);
});

test("the claim file disappearing under a container owner is reported too", () => {
    expect(() => run({ container: true, roots: true }, homeWith(), 4242)).toThrow(/claim file is gone/);
});

test("a guest holding the claim is the finding that locks the real sandbox out of its own box", () => {
    expect(() => run({ container: false, roots: true }, homeWith({ pid: 4242 }), 4242)).toThrow(/running as a guest but holds the container claim/);
});

test("a guest beside the daemon that does hold it is ordinary and silent", () => {
    expect(() => run({ container: false, roots: false }, homeWith({ pid: 9001 }), 4242)).not.toThrow();
});

test("a guest with no claim file at all is silent: there is nothing for it to be wrong about", () => {
    expect(() => run({ container: false, roots: true }, homeWith(), 4242)).not.toThrow();
});
