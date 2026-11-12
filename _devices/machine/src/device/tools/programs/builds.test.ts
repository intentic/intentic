import { BUILD_GRACE_MS, BUILD_KEEP_MS, BUILDS_KEPT, expiredBuilds, HALF_FILED_MS, type FiledBuild } from "./builds.js";

/* How long a pushed build stays, pure over a listing: the newest few of a name, a month at most, never one a running
   program holds, and a half-filed folder once it is a day old. */

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const HOUR = 60 * 60_000;

const build = (name: string, version: string, ageMs: number, complete = true): FiledBuild => ({ name, dir: `/runs/sb/${name}/${version}`, at: NOW - ageMs, complete });
const none = (): boolean => false;

test("a name keeps its newest builds; older ones go once past the grace", () => {
    const builds = Array.from({ length: BUILDS_KEPT + 2 }, (_, index) => build("server", `v${index}`, (index + 2) * HOUR));
    expect(expiredBuilds(builds, none, NOW).map((each) => each.dir)).toEqual(["/runs/sb/server/v3", "/runs/sb/server/v4"]);
});

test("each name is counted on its own", () => {
    const builds = [build("server", "a", 2 * HOUR), build("server", "b", 3 * HOUR), build("assets", "c", 4 * HOUR), build("assets", "d", 5 * HOUR)];
    expect(expiredBuilds(builds, none, NOW)).toEqual([]);
});

test("a build past the month goes even among the newest, and one inside the grace stays even past the count", () => {
    const old = build("tool", "old", BUILD_KEEP_MS);
    const fresh = Array.from({ length: BUILDS_KEPT + 1 }, (_, index) => build("server", `f${index}`, BUILD_GRACE_MS - HOUR / 2 + index));
    expect(expiredBuilds([old, ...fresh], none, NOW)).toEqual([old]);
});

test("a build a running program uses is never pruned and does not take a kept place", () => {
    const builds = [build("server", "running", 30 * 24 * HOUR), ...Array.from({ length: BUILDS_KEPT + 1 }, (_, index) => build("server", `v${index}`, (index + 2) * HOUR))];
    const inUse = (dir: string): boolean => dir.endsWith("/running");
    expect(expiredBuilds(builds, inUse, NOW).map((each) => each.dir)).toEqual([`/runs/sb/server/v${BUILDS_KEPT}`]);
});

test("a half-filed folder goes after a day, not while it may still be unpacking", () => {
    const dead = build("server", "dead", HALF_FILED_MS, false);
    const unpacking = build("server", "unpacking", HOUR, false);
    expect(expiredBuilds([dead, unpacking], none, NOW)).toEqual([dead]);
});
