import { categoryOf, filterKey, filterOf, indexCounts, matchesQuery, recentlySaved, visibleItems } from "./model.js";
import type { PasswordItem } from "./port.js";

const NOW = Date.UTC(2026, 9, 19, 12);
const SANDBOX = { url: "https://dev.intentic.dev", label: "intentic-dev" };

const item = (over: Partial<PasswordItem> & Pick<PasswordItem, "name" | "title">): PasswordItem => ({
    kind: "password",
    category: "site",
    origins: [],
    fresh: false,
    unverified: false,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    versions: 0,
    anyField: false,
    access: [],
    ...over,
});

const github = item({ name: "GITHUB_COM", title: "github.com", username: "radarsu", origins: [{ kind: "site", host: "github.com" }], fresh: true, captured: { source: "browser", via: "Brave", at: NOW - 3_600_000 } });
const forti = item({
    name: "FORTICLIENT",
    title: "FortiClient VPN",
    category: "app",
    origins: [{ kind: "program", program: "FortiClient.exe" }],
    access: [{ sandbox: SANDBOX, level: "while-here", since: NOW }],
    health: { weak: true, reused: false },
});
const build = item({ name: "SSH_RADAR_BUILD_01", title: "ssh radar@build-01", category: "terminal", origins: [{ kind: "ssh", target: "radar@build-01" }], fresh: true, captured: { source: "askpass", via: "ssh", at: NOW - 60_000 } });
const ALL = [github, forti, build];

test("a password's category is its first place", () => {
    expect(categoryOf([{ kind: "ssh", target: "a@b" }], "password")).toBe("terminal");
    expect(categoryOf([{ kind: "package", package: "com.example.app" }], "password")).toBe("phone");
    expect(categoryOf([], "text")).toBe("note");
});

test("a filter survives the URL", () => {
    for (const key of ["all", "site", "terminal", "fresh", "requests", "weak", `sandbox:${SANDBOX.url}`]) {
        expect(filterKey(filterOf(key))).toBe(key);
    }
    expect(filterOf("nonsense")).toEqual({ kind: "all" });
});

test("search needs every word somewhere", () => {
    expect(matchesQuery(github, "git radar")).toBe(true);
    expect(matchesQuery(github, "git forti")).toBe(false);
    expect(matchesQuery(forti, "forticlient.exe")).toBe(true);
});

test("lists are by title, and Just saved by when it was seen", () => {
    expect(visibleItems(ALL, { kind: "all" }, "").map((row) => row.name)).toEqual(["FORTICLIENT", "GITHUB_COM", "SSH_RADAR_BUILD_01"]);
    expect(visibleItems(ALL, { kind: "fresh" }, "").map((row) => row.name)).toEqual(["SSH_RADAR_BUILD_01", "GITHUB_COM"]);
    expect(visibleItems(ALL, { kind: "sandbox", url: SANDBOX.url }, "").map((row) => row.name)).toEqual(["FORTICLIENT"]);
    expect(visibleItems(ALL, { kind: "weak" }, "").map((row) => row.name)).toEqual(["FORTICLIENT"]);
});

test("the index counts what each entry would show", () => {
    const counts = indexCounts(ALL, []);
    expect(counts.all).toBe(3);
    expect(counts.category.terminal).toBe(1);
    expect(counts.sandbox.get(SANDBOX.url)).toBe(1);
    expect(counts.fresh).toBe(2);
    expect(counts.weak).toBe(1);
});

test("the strip holds a week of fresh captures, newest first", () => {
    const old = item({ name: "OLD", title: "old", fresh: true, captured: { source: "browser", via: "Brave", at: NOW - 9 * 86_400_000 } });
    expect(recentlySaved([...ALL, old], NOW).map((row) => row.name)).toEqual(["SSH_RADAR_BUILD_01", "GITHUB_COM"]);
});
