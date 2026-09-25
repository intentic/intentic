import { join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { statePath } from "../../../state-paths.js";
import { type CleanCandidate, planClean } from "./clean-plan.js";

// The plan is the last word before a removal: the cleaner runs it on candidates it just read from disk, and again on
// each one right before it goes. These pin what stays and why, at the edges of every rule it applies.

const roots = { workspace: WORKSPACE_ROOT, history: HISTORY_ROOT };
const inHistory = (...segments: string[]): string => join(HISTORY_ROOT, ...segments);
const inBrowser = (name: string): string => statePath(WORKSPACE_ROOT, ".intentic/local/browser/", name);
const NOW = Date.parse("2026-09-23T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const candidate = (path: string, over: Partial<CleanCandidate> = {}): CleanCandidate => ({
    path,
    folder: true,
    bytes: 4096,
    freeable: 4096,
    newestMs: NOW - 30 * 24 * HOUR,
    busy: false,
    ...over,
});

describe("planClean", () => {
    test("takes an old item of the category and says nothing else about it", () => {
        const trashed = candidate(inHistory("trash", "intentic-1789157840134"));
        expect(planClean("trash", [trashed], roots, NOW)).toEqual({ targets: [trashed], kept: [] });
    });

    test("keeps what is not one of the category's items: its folder, another category's path, anything off the volumes", () => {
        const plan = planClean(
            "trash",
            [
                candidate(inHistory("trash")),
                candidate(inHistory("worktrees", "fair-sage-ey2r")),
                candidate("/etc"),
                candidate(inHistory("trash", "a", "b")),
            ],
            roots,
            NOW,
        );
        expect(plan.targets).toEqual([]);
        expect(plan.kept).toEqual([
            { path: inHistory("trash"), reason: "elsewhere" },
            { path: inHistory("worktrees", "fair-sage-ey2r"), reason: "elsewhere" },
            { path: "/etc", reason: "elsewhere" },
            { path: inHistory("trash", "a", "b"), reason: "elsewhere" },
        ]);
    });

    test("a category that may not be cleaned keeps even its own items", () => {
        expect(planClean("checkouts", [candidate(inHistory("worktrees", "fair-sage-ey2r"))], roots, NOW).kept).toEqual([
            { path: inHistory("worktrees", "fair-sage-ey2r"), reason: "protected" },
        ]);
    });

    test("the day before now is kept, the moment past it is not", () => {
        const log = (age: number): CleanCandidate =>
            candidate(inHistory("logs", "terminals", `web-1-%${age}.log`), { folder: false, newestMs: NOW - age });
        const plan = planClean("logs", [log(24 * HOUR - 1), log(24 * HOUR)], roots, NOW);
        expect(plan.targets.map((target) => target.path)).toEqual([inHistory("logs", "terminals", `web-1-%${24 * HOUR}.log`)]);
        expect(plan.kept).toEqual([{ path: inHistory("logs", "terminals", `web-1-%${24 * HOUR - 1}.log`), reason: "recent" }]);
    });

    test("the trash has no such window: nothing reads it, however recently it was moved there or however skewed the clock", () => {
        const moved = [
            candidate(inHistory("trash", "site-1789157842097"), { newestMs: NOW }),
            candidate(inHistory("trash", "site-1789157842098"), { newestMs: NOW + HOUR }),
        ];
        expect(planClean("trash", moved, roots, NOW)).toEqual({ targets: moved, kept: [] });
    });

    test("anything a running program holds stays, however old", () => {
        const weights = statePath(WORKSPACE_ROOT, ".intentic/local/cache/", "models", "Qwen3.5-2B-Q4_K_M.gguf");
        expect(planClean("modelWeights", [candidate(weights, { folder: false, busy: true })], roots, NOW).kept).toEqual([
            { path: weights, reason: "busy" },
        ]);
    });

    test("only profile folders go from the browser's store: the files beside them are its accounts' state", () => {
        const plan = planClean(
            "browserProfiles",
            [
                candidate(inBrowser("radarsuspam2")),
                candidate(inBrowser("radarsuspam2.passkeys.json"), { folder: false }),
                candidate(inBrowser("saldeosmart-web.connected"), { folder: false }),
                candidate(inBrowser("web.stealth.js"), { folder: false }),
            ],
            roots,
            NOW,
        );
        expect(plan.targets.map((target) => target.path)).toEqual([inBrowser("radarsuspam2")]);
        expect(plan.kept.map((kept) => kept.reason)).toEqual(["protected", "protected", "protected"]);
    });

    test("a file clean takes files at any depth of its category, but not its neighbour's", () => {
        const plan = planClean(
            "buildCaches",
            [
                candidate(inHistory("gits", ".turbo", "cache", "0000effc265ff7b7.tar.zst"), { folder: false }),
                candidate(inHistory("gits", "intentic", "objects", "pack", "b.pack"), { folder: false }),
            ],
            roots,
            NOW,
        );
        expect(plan.targets.map((target) => target.path)).toEqual([inHistory("gits", ".turbo", "cache", "0000effc265ff7b7.tar.zst")]);
        expect(plan.kept).toEqual([{ path: inHistory("gits", "intentic", "objects", "pack", "b.pack"), reason: "elsewhere" }]);
    });
});
