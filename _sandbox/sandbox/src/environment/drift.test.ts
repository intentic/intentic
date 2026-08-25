import { expect, test } from "vitest";
import { collapseDriftPaths, containerBornAtMs, dpkgInstallsSince, installLive } from "./drift.js";

/* dpkg's log is the apt channel's whole input, so the parse is pinned to real log lines. */

const LOG = [
    "2026-08-20 09:00:00 startup packages configure",
    // Image-build installs, logged before the container was born.
    "2026-08-20 09:00:01 install ffmpeg:amd64 <none> 7:5.1.6",
    "2026-08-20 09:00:02 configure ffmpeg:amd64 7:5.1.6 <none>",
    // Runtime installs, after birth.
    "2026-08-25 13:27:40 install xdg-utils:all <none> 1.1.3-4.1",
    "2026-08-25 13:27:41 status installed xdg-utils:all 1.1.3-4.1",
    "2026-08-25 13:28:00 install p7zip-full:amd64 <none> 16.02",
    // An upgrade is not a new package.
    "2026-08-25 13:29:00 upgrade curl:amd64 7.88.1 7.88.2",
].join("\n");

const bornAt = Date.parse("2026-08-24T00:00:00");

test("packages installed after the container's birth are named; the image build's are not", () => {
    expect(dpkgInstallsSince(LOG, bornAt)).toEqual(["xdg-utils", "p7zip-full"]);
});

test("upgrades and configure passes are not installs", () => {
    expect(dpkgInstallsSince(LOG, 0)).toEqual(["ffmpeg", "xdg-utils", "p7zip-full"]);
});

test("a repeated install of one package is one entry", () => {
    const log = ["2026-08-25 10:00:00 install jq:amd64 <none> 1.6", "2026-08-25 11:00:00 install jq:amd64 <none> 1.6"].join("\n");
    expect(dpkgInstallsSince(log, 0)).toEqual(["jq"]);
});

test("a package tried and taken back is not drift", () => {
    const log = ["2026-08-25 10:00:00 install sl:amd64 <none> 5.02", "2026-08-25 10:05:00 remove sl:amd64 5.02 <none>"].join("\n");
    expect(dpkgInstallsSince(log, 0)).toEqual([]);
});

/* Collapsing: new binaries stay itemized by name, a bulk download becomes the directory that names it. */

test("shallow entries keep their names, deep trees collapse to the directory that names them", () => {
    const paths = [
        "/usr/local/bin/bun",
        "/usr/local/bin/cargo-xwin",
        ...Array.from({ length: 20 }, (_, index) => `/root/.cache/ms-playwright/chromium-1234/chrome-linux/locales/${index}.pak`),
    ];
    const collapsed = collapseDriftPaths(paths);
    expect(collapsed).toContain("/usr/local/bin/bun");
    expect(collapsed).toContain("/usr/local/bin/cargo-xwin");
    // One entry for the browser, at the SHALLOWEST directory deep enough to name it.
    expect(collapsed).toContain("/root/.cache/ms-playwright/chromium-1234/ (20 files)");
    expect(collapsed).toHaveLength(3);
});

test("a handful of deep files below the threshold stay itemized", () => {
    const paths = ["/usr/local/lib/python3.11/dist-packages/yaml/__init__.py"];
    expect(collapseDriftPaths(paths)).toEqual(paths);
});

test("the overall list is capped with an honest remainder", () => {
    const paths = Array.from({ length: 45 }, (_, index) => `/usr/local/bin/tool-${String(index).padStart(2, "0")}`);
    const collapsed = collapseDriftPaths(paths, 40);
    expect(collapsed).toHaveLength(41);
    expect(collapsed.at(-1)).toBe("… and 5 more");
});

/* The birth moment: exactness matters less than the invariants every reader leans on. */

test("the container's birth is a real moment in the past", async () => {
    const born = await containerBornAtMs();
    expect(born).toBeGreaterThan(0);
    expect(born).toBeLessThanOrEqual(Date.now());
});

test("two computations of the birth agree within jitter", async () => {
    const first = await containerBornAtMs();
    const second = await containerBornAtMs();
    expect(Math.abs(first - second)).toBeLessThan(5_000);
});

/* Corroboration: the apt channel is pure and provable here; the path channels stat real filesystems and are
 * exercised by the sweep itself rather than faked in a unit test. */

const drift = { bornAt: 0, at: 0, apt: ["xdg-utils"], paths: ["/usr/local/lib/python3.11/dist-packages/code_review_graph/cli.py"] };

test("an apt install is live exactly when dpkg logged it", async () => {
    expect(await installLive({ kind: "apt", tool: "xdg-utils" }, drift)).toBe(true);
    expect(await installLive({ kind: "apt", tool: "nsis" }, drift)).toBe(false);
});

test("a kind with no known landing spot matches drift paths with pip's underscore spelling normalised", async () => {
    expect(await installLive({ kind: "pip", tool: "code-review-graph" }, drift)).toBe(true);
    expect(await installLive({ kind: "pip", tool: "requests" }, drift)).toBe(false);
});
