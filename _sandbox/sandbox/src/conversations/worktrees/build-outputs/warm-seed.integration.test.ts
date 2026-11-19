import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { z } from "zod";
import { localPackages, packageNameOf, planProfile, profilesOf, seedTarget, type SeedTargetRequest } from "./warm-seed.js";

// Seeding a new checkout's Cargo target from another's (warm-seed.ts): what a plan reuses and leaves out in both of
// Cargo's layouts, how links and copies land, what makes a seed stand down, and, where this machine has cargo, a real
// second checkout reusing the dependencies while compiling its own crates from its own files.

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const scratch = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "warm-seed-"));
    dirs.push(dir);
    return dir;
};

const put = async (path: string, text = "x"): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
};

const TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# created by cargo\n";

// cargo 1.100's layout: one folder per package under build/, a folder per unit under it.
const newLayout = async (target: string): Promise<void> => {
    await put(join(target, "CACHEDIR.TAG"), TAG);
    await put(join(target, "debug", ".cargo-lock"), "");
    await put(join(target, "debug", "build", "serde", "aaaaaaaaaaaaaaaa", "out", "libserde-aaaaaaaaaaaaaaaa.rlib"), "serde rlib");
    await put(join(target, "debug", "build", "serde", "aaaaaaaaaaaaaaaa", "out", "libserde-aaaaaaaaaaaaaaaa.rmeta"), "serde rmeta");
    await put(join(target, "debug", "build", "serde", "aaaaaaaaaaaaaaaa", "fingerprint", "lib-serde.json"), "{}");
    await put(join(target, "debug", "build", "serde", "bbbbbbbbbbbbbbbb", "run", "stdout"), "cargo:rustc-cfg=x\n");
    await put(join(target, "debug", "build", "app", "cccccccccccccccc", "out", "app"), "app binary");
    await put(join(target, "debug", "build", "app", "cccccccccccccccc", "fingerprint", "bin-app.json"), "{}");
    await put(join(target, "debug", "build", "util", "dddddddddddddddd", "out", "libutil-dddddddddddddddd.rlib"), "util rlib");
    await put(join(target, "debug", "incremental", "app-1", "query-cache.bin"), "cache");
    await put(join(target, "debug", "app"), "uplifted");
    await put(join(target, "debug", "examples", "demo"), "example");
};

// The layout before it: fingerprints and build-script folders named `<package>-<hash>`, and one flat deps/.
const oldLayout = async (target: string): Promise<void> => {
    await put(join(target, "CACHEDIR.TAG"), TAG);
    await put(join(target, "wasm32-unknown-unknown", "release", ".cargo-lock"), "");
    const profile = join(target, "wasm32-unknown-unknown", "release");
    await put(join(profile, ".fingerprint", "serde-1111111111111111", "lib-serde"), "hash");
    await put(join(profile, ".fingerprint", "util-2222222222222222", "lib-util"), "hash");
    await put(join(profile, "build", "serde-3333333333333333", "out", "private.rs"), "generated");
    await put(join(profile, "build", "util-4444444444444444", "build-script-build"), "script");
    await put(join(profile, "deps", "libserde-1111111111111111.rlib"), "serde rlib");
    await put(join(profile, "deps", "serde-1111111111111111.d"), "deps");
    await put(join(profile, "deps", "libutil-2222222222222222.rlib"), "util rlib");
    await put(join(profile, "deps", "util-2222222222222222.d"), "deps");
};

const LOCAL = new Set(["app", "util"]);

test("a package's own name is read from its [package] table, and a virtual manifest declares none", () => {
    expect(packageNameOf('[workspace]\nmembers = ["a"]\n\n[package]\nversion = "1"\nname = "my-crate"\n')).toBe("my-crate");
    expect(packageNameOf('[workspace]\nmembers = ["a"]\n[workspace.package]\nname = "not-a-package"\n')).toBeUndefined();
    expect(packageNameOf('[dependencies]\nname = "x"\n')).toBeUndefined();
});

test("cargo 1.100's layout: the checkout's own packages, incremental caches, uplifted files and examples stay behind", async () => {
    const target = join(await scratch(), "target");
    await newLayout(target);
    expect(await profilesOf(target)).toEqual(["debug"]);
    const plan = await planProfile(target, "debug", LOCAL);
    expect(plan?.link.toSorted()).toEqual([
        "build/serde/aaaaaaaaaaaaaaaa/out/libserde-aaaaaaaaaaaaaaaa.rlib",
        "build/serde/aaaaaaaaaaaaaaaa/out/libserde-aaaaaaaaaaaaaaaa.rmeta",
    ]);
    expect(plan?.copy.toSorted()).toEqual(["build/serde/aaaaaaaaaaaaaaaa/fingerprint/lib-serde.json", "build/serde/bbbbbbbbbbbbbbbb/run/stdout"]);
});

test("the older layout: a package's fingerprints, build-script folders and the deps/ files carrying their hash stay behind", async () => {
    const target = join(await scratch(), "target");
    await oldLayout(target);
    expect(await profilesOf(target)).toEqual(["wasm32-unknown-unknown/release"]);
    const plan = await planProfile(target, "wasm32-unknown-unknown/release", LOCAL);
    expect(plan?.link).toEqual(["deps/libserde-1111111111111111.rlib"]);
    expect(plan?.copy.toSorted()).toEqual([".fingerprint/serde-1111111111111111/lib-serde", "build/serde-3333333333333333/out/private.rs", "deps/serde-1111111111111111.d"]);
});

test("the packages either checkout declares, tracked or not, are the ones a seed leaves out", async () => {
    const root = await scratch();
    await put(join(root, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n');
    await put(join(root, "crates", "engine", "Cargo.toml"), '[package]\nname = "engine"\n');
    await put(join(root, "vendored", "Cargo.toml"), '[package]\nname = "ignored-one"\n');
    await put(join(root, ".gitignore"), "vendored/\n");
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    expect(spawnSync("git", ["-C", root, "add", "Cargo.toml", ".gitignore"]).status).toBe(0);
    // `engine` was never added: a crate the lending checkout made and did not commit is still its own.
    expect([...(await localPackages([root]))]).toEqual(["engine"]);
});

const request = async (source: string, overrides: Partial<SeedTargetRequest> = {}): Promise<SeedTargetRequest> => {
    const dir = await scratch();
    await mkdir(join(dir, "checkout"), { recursive: true });
    return {
        source,
        dest: join(dir, "checkout", "target"),
        rel: "target",
        local: LOCAL,
        stagingRoot: join(dir, "staging"),
        limits: { copyBytes: 1_000_000, deadline: Date.now() + 60_000 },
        ...overrides,
    };
};

test("a seed links the compiled libraries, copies the rest, and lands as the checkout's target in one move", async () => {
    const source = join(await scratch(), "target");
    await newLayout(source);
    const ask = await request(source);
    const outcome = await seedTarget(ask);
    expect(outcome).toMatchObject({ state: "seeded", profiles: ["debug"], from: source });
    const rlib = join("debug", "build", "serde", "aaaaaaaaaaaaaaaa", "out", "libserde-aaaaaaaaaaaaaaaa.rlib");
    const stdout = join("debug", "build", "serde", "bbbbbbbbbbbbbbbb", "run", "stdout");
    expect((await stat(join(ask.dest, rlib))).ino).toBe((await stat(join(source, rlib))).ino);
    expect((await stat(join(ask.dest, stdout))).ino).not.toBe((await stat(join(source, stdout))).ino);
    expect(await readFile(join(ask.dest, stdout), "utf8")).toBe("cargo:rustc-cfg=x\n");
    expect(await readFile(join(ask.dest, "CACHEDIR.TAG"), "utf8")).toBe(TAG);
    expect((await readdir(join(ask.dest, "debug", "build"))).toSorted()).toEqual(["serde"]);
    expect(await readdir(join(ask.dest, "debug"))).toEqual(["build"]);
    // Nothing is left in staging.
    expect(await readdir(ask.stagingRoot)).toEqual([]);
});

test("a copy keeps each file's time, which is what Cargo compares", async () => {
    const source = join(await scratch(), "target");
    await newLayout(source);
    const stdout = join("debug", "build", "serde", "bbbbbbbbbbbbbbbb", "run", "stdout");
    const then = new Date("2026-01-02T03:04:05Z");
    await utimes(join(source, stdout), then, then);
    const ask = await request(source);
    await seedTarget(ask);
    expect((await stat(join(ask.dest, stdout))).mtime).toEqual(then);
});

test("a target the checkout built first is never replaced", async () => {
    const source = join(await scratch(), "target");
    await newLayout(source);
    const ask = await request(source);
    await put(join(ask.dest, "debug", "own"), "the checkout's own build");
    expect(await seedTarget(ask)).toMatchObject({ state: "skipped", reason: "the checkout built its own target first" });
    expect(await readdir(join(ask.dest, "debug"))).toEqual(["own"]);
});

test("a profile past the copy budget or the disk's room is left out, and says so", async () => {
    const source = join(await scratch(), "target");
    await newLayout(source);
    const outcome = await seedTarget(await request(source, { limits: { copyBytes: 1, deadline: Date.now() + 60_000 } }));
    expect(outcome.state).toBe("skipped");
    expect(outcome.reason).toMatch(/^left out: debug \(no room to copy/u);
    const short = await seedTarget(await request(source, { roomFor: () => Promise.resolve(false) }));
    expect(short.reason).toMatch(/^left out: debug \(no room to copy/u);
});

test("a profile a build holds is left out rather than copied half-written", async () => {
    const source = join(await scratch(), "target");
    await newLayout(source);
    // A build's hold on the profile, as cargo takes it.
    const holder = spawn("flock", [join(source, "debug", ".cargo-lock"), "sleep", "30"], { stdio: "ignore" });
    try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const outcome = await seedTarget(await request(source, { limits: { copyBytes: 1_000_000, deadline: Date.now() + 1_500 } }));
        expect(outcome.state).toBe("skipped");
        expect(outcome.reason).toMatch(/left out: debug \((a build was running there|out of time)\)/u);
    } finally {
        holder.kill("SIGKILL");
    }
});

// --- a real second checkout, where this machine has cargo ---

const accountHome = (): string => spawnSync("getent", ["passwd", String(userInfo().uid)], { encoding: "utf8" }).stdout.split(":")[5] ?? "";

// Cargo's own environment, without what a developer's shell steers it with, and with no compiler wrapper: the seed is
// measured, not a cache.
const cargoEnv = (): NodeJS.ProcessEnv => {
    const home = accountHome();
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CARGO_TARGET_DIR|CARGO_BUILD_|RUSTFLAGS|RUSTC_WRAPPER|CARGO_PROFILE_|CARGO_INCREMENTAL)/u.test(name))),
        RUSTUP_HOME: process.env["RUSTUP_HOME"] ?? join(home, ".rustup"),
        CARGO_HOME: process.env["CARGO_HOME"] ?? join(home, ".cargo"),
    };
};

const machine = requires(spawnSync("cargo", ["--version"], { env: cargoEnv(), timeout: 30_000 }).status === 0, "cargo on PATH", {
    absentOnCi: "cargo is baked into ci-desktop only",
});

// A dependency outside both checkouts with a build script, standing in for the registry's: the same files for both.
const DEPS = {
    "leaf/Cargo.toml": '[package]\nname = "leaf"\nversion = "0.1.0"\nedition = "2021"\n',
    "leaf/build.rs": 'fn main() {\n    let out = std::env::var("OUT_DIR").unwrap();\n    std::fs::write(format!("{out}/gen.rs"), "pub const GEN: u32 = 7;").unwrap();\n}\n',
    "leaf/src/lib.rs": 'include!(concat!(env!("OUT_DIR"), "/gen.rs"));\n',
};

const WORKSPACE = {
    "Cargo.toml": '[workspace]\nmembers = ["app", "util"]\nresolver = "2"\n',
    "app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nleaf = { path = "../../deps/leaf" }\nutil = { path = "../util" }\n',
    "app/src/main.rs": 'fn main() {\n    println!("{} {}", leaf::GEN, util::VALUE);\n}\n',
    "util/Cargo.toml": '[package]\nname = "util"\nversion = "0.1.0"\nedition = "2021"\n',
    "util/src/lib.rs": "pub const VALUE: u32 = 1;\n",
    ".gitignore": "target\n",
};

const files = async (root: string, tree: Readonly<Record<string, string>>): Promise<void> => {
    for (const [path, text] of Object.entries(tree)) {
        await put(join(root, path), text);
    }
};

const ArtifactMessage = z.object({ reason: z.literal("compiler-artifact"), fresh: z.boolean(), target: z.object({ name: z.string(), kind: z.array(z.string()) }) });

interface Units {
    readonly fresh: string[];
    readonly built: string[];
}

// Which units a `--message-format=json` build reused and which it compiled.
const unitsOf = (stdout: string): Units => {
    const fresh: string[] = [];
    const built: string[] = [];
    for (const line of stdout.split("\n").filter((text) => text.startsWith("{"))) {
        const message = ArtifactMessage.safeParse(JSON.parse(line));
        if (message.success) {
            (message.data.fresh ? fresh : built).push(`${message.data.target.name}:${message.data.target.kind.join(",")}`);
        }
    }
    return { fresh: fresh.toSorted(), built: built.toSorted() };
};

const git = (cwd: string, ...args: string[]): void => {
    expect(spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd }).status).toBe(0);
};

const build = (cwd: string): Units => {
    const ran = spawnSync("cargo", ["build", "--offline", "-j", "2", "--message-format=json"], { cwd, env: cargoEnv(), encoding: "utf8", timeout: 300_000 });
    expect(ran.status).toBe(0);
    return unitsOf(ran.stdout);
};

test.skipIf(!machine.runs)(
    machine.title("a checkout cut before its lender rebuilt an uncommitted edit compiles its own crates from its own files and reuses the rest"),
    async () => {
        const dir = await scratch();
        const lender = join(dir, "lender");
        const child = join(dir, "child");
        await files(join(dir, "deps"), DEPS);
        await files(lender, WORKSPACE);
        expect(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: lender, env: cargoEnv() }).status).toBe(0);
        git(lender, "init", "-q", "-b", "main");
        git(lender, "add", "-A");
        git(lender, "commit", "-qm", "init");
        expect(build(lender).built).toEqual(["app:bin", "build-script-build:custom-build", "leaf:lib", "util:lib"]);
        // The child's files are written, then the lender edits without committing and builds again: every record of
        // `util` in the lender's target is newer than the child's copy of util's source.
        git(lender, "worktree", "add", "-q", child, "HEAD");
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        await writeFile(join(lender, "util", "src", "lib.rs"), "pub const VALUE: u32 = 2;\n");
        build(lender);

        const outcome = await seedTarget({
            source: join(lender, "target"),
            dest: join(child, "target"),
            rel: "target",
            local: await localPackages([child, lender]),
            stagingRoot: join(dir, "staging"),
            limits: { copyBytes: 1024 ** 3, deadline: Date.now() + 120_000 },
        });
        expect(outcome.state).toBe("seeded");
        // The dependency and its build script come from the lender; the workspace's own crates compile here.
        expect(build(child)).toEqual({ fresh: ["build-script-build:custom-build", "leaf:lib"], built: ["app:bin", "util:lib"] });
        const ran = spawnSync(join(child, "target", "debug", "app"), { encoding: "utf8" });
        expect(ran.stdout.trim()).toBe("7 1");
    },
);
