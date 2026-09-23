import { checkRunningIn, isBuildOutputPath, markCheckRunning } from "./checks-in-flight.js";

test("a check marks the repo it runs in and no other; the root project is the root repo's", () => {
    const done = markCheckRunning("extensions/saldeo");
    expect(checkRunningIn("extensions/saldeo")).toBe(true);
    expect(checkRunningIn("extensions/scrub")).toBe(false);
    expect(checkRunningIn("root")).toBe(false);
    done();
    expect(checkRunningIn("extensions/saldeo")).toBe(false);

    const rootDone = markCheckRunning("");
    expect(checkRunningIn("root")).toBe(true);
    expect(checkRunningIn("extensions/saldeo")).toBe(false);
    rootDone();
    expect(checkRunningIn("root")).toBe(false);
});

test("a project nested in a repo marks that repo, and a repo whose id merely starts the same does not", () => {
    const done = markCheckRunning("intentic/_editor/web");
    expect(checkRunningIn("intentic")).toBe(true);
    expect(checkRunningIn("inten")).toBe(false);
    done();
    expect(checkRunningIn("intentic")).toBe(false);
});

test("overlapping checks each hold the window open: the last release closes it", () => {
    const first = markCheckRunning("app");
    const second = markCheckRunning("app");
    first();
    expect(checkRunningIn("app")).toBe(true);
    second();
    expect(checkRunningIn("app")).toBe(false);
});

test("build output is a whole path segment, so a file merely named after one is the owner's work", () => {
    expect(isBuildOutputPath("dist/bin/saldeo-mcp")).toBe(true);
    expect(isBuildOutputPath("packages/ui/node_modules/left-pad/index.js")).toBe(true);
    expect(isBuildOutputPath("src/dist.ts")).toBe(false);
    expect(isBuildOutputPath("src/distributed/queue.ts")).toBe(false);
});
