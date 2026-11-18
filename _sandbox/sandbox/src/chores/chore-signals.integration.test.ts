import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSearchResult } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { recordingLogger } from "../harness/route-fakes.testing.js";
import { sharedChoreSignals } from "./chore-signals.js";
import type { FileQuery } from "../workspace/text-search.js";
import { useCheckoutFeed } from "../git/feed/checkout-feed.js";

// The rail badge and the panel list at once. A reading of a repo is shared only with a caller that asked before it
// began, so whatever either is shown was read after it asked; one begun earlier is waited out and read again.

// A file count of the readings so far, as a search result.
const counted = (files: number): WorkspaceSearchResult => ({
    mode: "files",
    total: files,
    files,
    shown: 0,
    groups: [],
    freshness: { state: "fresh" },
    truncated: files > 0,
});

// The file-count half held open per call until the test lets it go, counting the readings each repo got.
const heldCount = () => {
    const begun: string[] = [];
    const releases: (() => void)[] = [];
    const files = async ({ paths }: FileQuery): Promise<WorkspaceSearchResult> => {
        begun.push(paths?.[0] ?? "");
        await new Promise<void>((resolve) => releases.push(resolve));
        return counted(begun.length);
    };
    const services = unstubbed<Pick<Services, "textSearch" | "workspace" | "logger">>("services", {
        textSearch: unstubbed<Services["textSearch"]>("textSearch", { files }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: mkdtempSync(join(tmpdir(), "chores-shared-")) }),
    });
    return { services, begun, release: () => releases.shift()?.() };
};

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 1));

afterEach(() => useCheckoutFeed(undefined));

test("unchanged checkout generations retain completed evidence and a write refreshes it", async () => {
    let generation = 1;
    useCheckoutFeed({ generation: async () => generation });
    const { services, begun, release } = heldCount();
    const shared = sharedChoreSignals(services);
    const first = shared.of("a", shared.asked());
    await settle();
    release();
    expect((await first).totals.files).toBe(1);
    expect((await shared.of("a", shared.asked())).totals.files).toBe(1);
    expect(begun).toEqual(["a"]);
    generation += 1;
    const changed = shared.of("a", shared.asked());
    await settle();
    release();
    expect((await changed).totals.files).toBe(2);
    expect(begun).toEqual(["a", "a"]);
});

test("a reading begun after a caller asked is shared with it, and one begun before is read again once it is done", async () => {
    const { services, begun, release } = heldCount();
    const shared = sharedChoreSignals(services);

    const badge = shared.asked();
    const badgeFirst = shared.of("a", badge);
    await settle();
    // The panel asks while the badge's reading of `a` is under way: that reading began first, so it is not the panel's.
    const panel = shared.asked();
    const panelFirst = shared.of("a", panel);
    await settle();
    expect(begun).toEqual(["a"]);
    release();
    const badgeA = await badgeFirst;
    await settle();
    expect(begun).toEqual(["a", "a"]);
    release();
    const panelA = await panelFirst;
    expect(panelA).not.toBe(badgeA);
    expect(panelA.totals.files).toBe(2);

    // The badge moves on to `b` after the panel asked: that reading is the panel's as much as the badge's.
    const badgeSecond = shared.of("b", badge);
    const panelSecond = shared.of("b", panel);
    await settle();
    expect(begun).toEqual(["a", "a", "b"]);
    release();
    expect(await panelSecond).toBe(await badgeSecond);
});

test("everyone who asked while a reading was under way shares the one that follows it", async () => {
    const { services, begun, release } = heldCount();
    const shared = sharedChoreSignals(services);
    const under = shared.of("a", shared.asked());
    await settle();
    const late = [shared.of("a", shared.asked()), shared.of("a", shared.asked()), shared.of("a", shared.asked())];
    release();
    await under;
    await settle();
    release();
    const answers = await Promise.all(late);
    expect(begun).toEqual(["a", "a"]);
    expect(new Set(answers).size).toBe(1);
    // Nothing is held once no one is waiting: the next caller begins its own.
    const after = shared.of("a", shared.asked());
    await settle();
    release();
    await after;
    expect(begun).toEqual(["a", "a", "a"]);
});

// A count that fails costs the list that repo's size, never the list: the manifests are still read, and the next ask
// tries again.
test("a failing file count lists the repo without a size, and is not kept", async () => {
    useCheckoutFeed({ generation: async () => 1 });
    const root = mkdtempSync(join(tmpdir(), "chores-degraded-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3.0.0" } }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - libs/*\n");
    mkdirSync(join(root, "libs/one"), { recursive: true });
    writeFileSync(join(root, "libs/one/package.json"), JSON.stringify({ name: "@x/one", dependencies: { zod: "^4.0.0" } }));
    let asked = 0;
    const files = async (): Promise<WorkspaceSearchResult> => {
        asked += 1;
        throw new Error("ripgrep could not list the files: permission denied");
    };
    const { lines, logger } = recordingLogger();
    const services = unstubbed<Pick<Services, "textSearch" | "workspace" | "logger">>("services", {
        textSearch: unstubbed<Services["textSearch"]>("textSearch", { files }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger,
    });
    const shared = sharedChoreSignals(services);

    const reading = await shared.of("", shared.asked());
    expect(reading.packages).toEqual([{ dir: "libs/one", name: "@x/one", dependencies: ["zod"], devDependencies: [], documented: false }]);
    expect(reading.shape).toEqual({ docs: [], dockerfiles: [], ci: [], lockfile: false, packageManifest: true, deps: ["vue", "zod"] });
    expect([reading.hotspots, reading.keyModules]).toEqual([[], []]);
    expect(reading.totals).toEqual({ files: 0, symbols: 0, complexity: 0, hotspots: 0 });
    expect(reading.indexed).toBe(false);
    expect(lines.filter((line) => line["level"] === "warn").map((line) => line["message"])).toEqual([
        "chores: could not count the repo's code files, listing without a size",
    ]);

    await shared.of("", shared.asked());
    expect(asked).toBe(2);
});
