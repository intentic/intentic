import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { workspaceMapNote, workspaceMapOf } from "./workspace-map.js";

// Pins properties nobody would notice breaking without a test: the starting position decides what's mapped, shape rules
// key on structure not naming, a purpose is never invented, and the budget sheds whole areas rather than truncating
// silently.

const dirs: string[] = [];

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "workspace-map-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const pkg = (name: string, description?: string): string => JSON.stringify({ name, ...(description === undefined ? {} : { description }) });
const named = (map: { areas: readonly { name: string }[] } | undefined): string[] => (map?.areas ?? []).map((area) => area.name);

test("areas are the project's own top-level directories, biggest first", async () => {
    const root = await scaffold({
        ".git/HEAD": "ref: refs/heads/main\n",
        "server/a.py": "",
        "server/b.py": "",
        "server/c.py": "",
        "client/a.tsx": "",
        "client/b.tsx": "",
        "docs/guide.md": "",
    });

    const map = workspaceMapOf({ root, cwd: root });

    expect(named(map)).toEqual(["server", "client", "docs"]);
    expect(map?.areas[0]).toMatchObject({ files: 3, kinds: ["py"] });
});

test("the map is rooted at the project the run starts in, not at the workspace", async () => {
    const root = await scaffold({
        "toolbox/notes.md": "",
        "shop/.git/HEAD": "ref: refs/heads/main\n",
        "shop/checkout/a.ts": "",
        "shop/checkout/b.ts": "",
        "shop/catalog/a.ts": "",
    });

    // Standing two levels inside `shop`: project is `shop`; the workspace's other entries are named, not mapped.
    const map = workspaceMapOf({ root, cwd: join(root, "shop/checkout") });

    expect(map?.project).toBe("shop");
    expect(named(map)).toEqual(["checkout", "catalog"]);
    expect(map?.siblings).toEqual(["toolbox"]);
    expect(map?.areas.find((area) => area.name === "checkout")?.here).toBe(true);
    expect(map?.areas.find((area) => area.name === "catalog")?.here).toBe(false);
});

test("a run at the workspace root maps the workspace and names no siblings", async () => {
    const root = await scaffold({ "one/a.ts": "", "two/b.ts": "", "three/c.ts": "" });

    const map = workspaceMapOf({ root, cwd: root });

    expect(map?.project).toBe("");
    expect(map?.siblings).toEqual([]);
    expect(map?.areas.every((area) => !area.here)).toBe(true);
});

test("a repository that IS a shelf promotes its packages to areas", async () => {
    const root = await scaffold({
        ".git/HEAD": "ref: refs/heads/main\n",
        "README.md": "# monorepo\n",
        "packages/api/package.json": pkg("@x/api", "HTTP surface"),
        "packages/web/package.json": pkg("@x/web"),
        "packages/cli/package.json": pkg("@x/cli"),
    });

    const map = workspaceMapOf({ root, cwd: root });

    expect(named(map)).toEqual(["packages/api", "packages/cli", "packages/web"]);
    expect(map?.areas.find((area) => area.name === "packages/api")?.purpose).toBe("HTTP surface");
});

test("a shelf among real areas stays one line, and opens only when the run is inside it", async () => {
    const files = {
        ".git/HEAD": "ref: refs/heads/main\n",
        "docs/a.md": "",
        "docs/b.md": "",
        "docs/c.md": "",
        "docs/d.md": "",
        "infra/main.tf": "",
        "packages/api/package.json": pkg("@x/api", "HTTP surface"),
        "packages/web/package.json": pkg("@x/web"),
        "packages/cli/package.json": pkg("@x/cli"),
    };
    const outside = await scaffold(files);
    const inside = await scaffold(files);

    const shut = workspaceMapOf({ root: outside, cwd: outside });
    const open = workspaceMapOf({ root: inside, cwd: join(inside, "packages/web") });

    expect(named(shut)).toEqual(["docs", "packages", "infra"]);
    expect(named(open)).toEqual(["docs", "packages", "infra"]);
    expect(shut?.areas.find((area) => area.name === "packages")).toMatchObject({ packages: 3, children: [] });
    expect(open?.areas.find((area) => area.name === "packages")?.children.map((child) => child.name)).toEqual([
        "packages/api",
        "packages/cli",
        "packages/web",
    ]);
    expect(open?.areas.find((area) => area.name === "packages")?.children.find((child) => child.name === "packages/web")?.here).toBe(true);
});

test("at the project root the area holding most of the project is opened up", async () => {
    const root = await scaffold({
        ".git/HEAD": "ref: refs/heads/main\n",
        // Its own manifest makes this an area, not a shelf of packages.
        "app/package.json": pkg("app", "The product"),
        "app/server/a.ts": "",
        "app/server/b.ts": "",
        "app/server/c.ts": "",
        "app/ui/a.tsx": "",
        "app/ui/b.tsx": "",
        "notes/one.md": "",
    });

    const map = workspaceMapOf({ root, cwd: root });

    expect(named(map)).toEqual(["app", "notes"]);
    expect(map?.areas[0]?.children.map((child) => child.name)).toEqual(["app/server", "app/ui"]);
    expect(map?.areas[0]?.children[0]).toMatchObject({ files: 3, kinds: ["ts"], here: false });
    expect(map?.areas[0]?.here).toBe(false);
});

// Majority, not merely largest: three equal thirds is a tie, and opening one would be picking a favourite.
test("no area is opened up when none of them dominates", async () => {
    const root = await scaffold({
        ".git/HEAD": "ref: refs/heads/main\n",
        "one/src/a.ts": "",
        "one/src/b.ts": "",
        "two/src/a.ts": "",
        "two/src/b.ts": "",
        "three/src/a.ts": "",
        "three/src/b.ts": "",
    });

    const map = workspaceMapOf({ root, cwd: root });

    expect(named(map)).toEqual(["one", "three", "two"]);
    expect(map?.areas.every((area) => area.children.length === 0)).toBe(true);
});

// The note-wide budget could otherwise let one area's forty subdirectories crowd out the rest of the note; children are
// capped independently.
test("an opened area lists at most a dozen children and counts the rest out loud", async () => {
    const root = await scaffold({
        ".git/HEAD": "ref: refs/heads/main\n",
        "notes/one.md": "",
        ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`app/part-${index}/file.ts`, ""])),
    });

    const map = workspaceMapOf({ root, cwd: root });
    const note = workspaceMapNote({ root, cwd: root });

    expect(map?.areas[0]?.children).toHaveLength(12);
    expect(map?.areas[0]?.childrenOmitted).toBe(8);
    expect(note).toContain("… and 8 more in app");
});

test("a purpose is read from whatever manifest the ecosystem uses, and a README when there is none", async () => {
    const root = await scaffold({
        ".git/HEAD": "ref: refs/heads/main\n",
        "node-thing/package.json": pkg("thing", "A node thing"),
        "node-thing/a.ts": "",
        "rust-thing/Cargo.toml": '[package]\nname = "rust-thing"\ndescription = "A rust thing"\n',
        "rust-thing/a.rs": "",
        "py-thing/pyproject.toml": '[project]\nname = "py-thing"\ndescription = "A python thing"\n',
        "py-thing/a.py": "",
        "go-thing/go.mod": "module github.com/acme/go-thing\n\ngo 1.22\n",
        "go-thing/a.go": "",
        // No manifest: purpose is the README's first line of prose, after the title, badges, and block quote.
        "read-thing/README.md":
            "# read-thing\n\n[![build](https://img.shields.io/x.svg)](https://ci.example)\n\n> a pull quote\n\nA documented thing.\n",
        "read-thing/a.md": "",
        // Nothing to say, and an empty purpose is the answer, not a guess.
        "quiet-thing/a.txt": "",
    });

    const purposes = Object.fromEntries((workspaceMapOf({ root, cwd: root })?.areas ?? []).map((area) => [area.name, area.purpose]));

    expect(purposes).toEqual({
        "node-thing": "A node thing",
        "rust-thing": "A rust thing",
        "py-thing": "A python thing",
        "go-thing": "Go module acme/go-thing",
        "read-thing": "A documented thing.",
        "quiet-thing": "",
    });
});

test("build output, dependencies and the workspace's reserved directories are not areas", async () => {
    const root = await scaffold({
        "src/a.ts": "",
        "lib/b.ts": "",
        "node_modules/dep/index.js": "",
        "dist/bundle.js": "",
        ".cache/x": "",
        // Reserved only at the workspace's top level: the reference shelf and the public outbox.
        "refs/cloned-repo/a.ts": "",
        "public/report.html": "",
    });

    // Sorted here since these two tie in size; alphabetical tie-break is a ranking detail, not an area rule.
    expect(named(workspaceMapOf({ root, cwd: root })).toSorted()).toEqual(["lib", "src"]);
});

test("nothing worth saying yields no note at all", async () => {
    const bare = await scaffold({ "only/a.ts": "" });
    const empty = await scaffold({ "README.md": "# nothing here\n" });

    expect(workspaceMapOf({ root: bare, cwd: bare })).toBeUndefined();
    expect(workspaceMapNote({ root: empty, cwd: empty })).toBeUndefined();
    // A path that is not there is an ordinary outcome, never a throw: this is help nobody asked for on this turn.
    expect(workspaceMapNote({ root: join(bare, "gone"), cwd: join(bare, "gone") })).toBeUndefined();
});

test("the note holds its budget by shedding detail, and says how much it shed", async () => {
    const files: Record<string, string> = { ".git/HEAD": "ref: refs/heads/main\n" };
    for (let i = 0; i < 60; i += 1) {
        files[`area-${String(i).padStart(2, "0")}/package.json`] = pkg(
            `@x/a${i}`,
            `The ${i}th area of a rather large repository, described at some length`,
        );
        files[`area-${String(i).padStart(2, "0")}/a.ts`] = "";
    }
    const root = await scaffold(files);

    const note = workspaceMapNote({ root, cwd: root });

    expect(note?.length).toBeLessThanOrEqual(2_800);
    // What was dropped is counted out loud: the list must never merely stop.
    expect(note).toMatch(/not listed|and \d+ more/);
});

test("the note names where the run stands and marks it in the list", async () => {
    const root = await scaffold({
        "app/.git/HEAD": "ref: refs/heads/main\n",
        "app/billing/a.ts": "",
        "app/billing/b.ts": "",
        "app/mailer/a.ts": "",
    });

    const note = workspaceMapNote({ root, cwd: join(root, "app/billing") });

    expect(note?.startsWith("## Map of this project")).toBe(true);
    expect(note).toMatch(/ls.*tree/i);
    expect(note).toContain("app/billing");
    expect(note).toMatch(/billing.*← you are here/);
    expect(note).not.toMatch(/mailer.*← you are here/);
});
