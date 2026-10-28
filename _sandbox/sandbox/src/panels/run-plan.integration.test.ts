import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseProcfile, procfileCommand, runPlanOf } from "./run-plan.js";

// What Start runs, read off real repositories on disk, since the answer is exactly what the files say.

const repo = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "run-plan-"));
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
    }
    return dir;
};

const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: "app", scripts });
const crate = (name: string, extra = ""): string => `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${extra}`;

test("a Procfile is read the way foreman reads it: comments, blanks and a repeated name skipped", () => {
    expect(parseProcfile("# the stack\nweb: pnpm dev --port $PORT\n\n  worker:   cargo run --bin worker  \nweb: ignored\nnot an entry\n")).toEqual([
        { name: "web", command: "pnpm dev --port $PORT" },
        { name: "worker", command: "cargo run --bin worker" },
    ]);
    expect(parseProcfile("# nothing here\n\n")).toEqual([]);
});

test("a Procfile wins over every other way to start, and a Node repo still installs first", async () => {
    const dir = repo({ Procfile: "web: pnpm dev\n", "package.json": pkg({ dev: "vite" }), "Cargo.toml": crate("game"), "src/main.rs": "fn main() {}" });
    expect(await runPlanOf(dir)).toEqual({
        source: "procfile",
        cwd: dir,
        shown: "pnpm dev",
        command: "test -d node_modules || pnpm install && pnpm dev",
        installed: false,
    });
    const several = repo({ Procfile: "game: cargo run\ntools: cargo run --bin tools\n", "Cargo.toml": crate("game") });
    const plan = await runPlanOf(several);
    expect(plan?.shown).toBe("Procfile: game, tools");
    // A Cargo-only Procfile has nothing for pnpm to install; its first build is what target/ says.
    expect(plan?.command.startsWith("bash -c ")).toBe(true);
    expect(plan?.installed).toBe(false);
});

// Runs a command the way a panel's terminal does: in a process group of its own (zsh's job control gives every job one),
// which is the group the trap's `kill 0` ends. Answers what it printed.
const runAsJob = (command: string, env: Record<string, string>): Promise<string> =>
    new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", command], { env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString();
        });
        const deadline = setTimeout(() => {
            process.kill(-(child.pid ?? 0), "SIGKILL");
            reject(new Error(`still running after 20s, printed: ${out}`));
        }, 20_000);
        child.on("close", () => {
            clearTimeout(deadline);
            resolve(out);
        });
    });

test("several Procfile entries run together: only `web` gets the port, and when it ends the rest end with it", async () => {
    const command = procfileCommand([
        { name: "worker", command: `echo "worker:\${PORT:-none}"; sleep 30; echo late` },
        { name: "web", command: `sleep 0.3; echo "web:$PORT"` },
    ]);
    const started = Date.now();
    const out = await runAsJob(command, { PORT: "4321" });
    expect(out.split("\n").filter(Boolean).toSorted()).toEqual(["web:4321", "worker:none"]);
    // The worker's 30-second sleep did not hold the run open.
    expect(Date.now() - started).toBeLessThan(10_000);
});

test("operator/ beats the root, the root's dev beats its start, and start is enough on its own", async () => {
    const both = repo({ "operator/package.json": pkg({ dev: "vite" }), "package.json": pkg({ dev: "turbo dev" }) });
    expect((await runPlanOf(both))?.cwd).toBe(join(both, "operator"));
    expect((await runPlanOf(repo({ "package.json": pkg({ dev: "vite", start: "node ." }) })))?.shown).toBe("pnpm dev");
    const server = repo({ "package.json": pkg({ start: "node server.js" }), "node_modules/.keep": "" });
    expect(await runPlanOf(server)).toEqual({
        source: "start",
        cwd: server,
        shown: "pnpm start",
        command: "test -d node_modules || pnpm install && pnpm start",
        installed: true,
    });
    // A manifest that does not parse, or names neither script, starts nothing.
    expect(await runPlanOf(repo({ "package.json": "{ not json" }))).toBeUndefined();
    expect(await runPlanOf(repo({ "package.json": pkg({ test: "vitest" }) }))).toBeUndefined();
});

test("a Tauri-style repo starts through its package.json, which drives cargo itself", async () => {
    const dir = repo({ "package.json": pkg({ dev: "tauri dev" }), "src-tauri/Cargo.toml": crate("shell"), "Cargo.toml": crate("game"), "src/main.rs": "" });
    expect((await runPlanOf(dir))?.source).toBe("dev");
});

test("a crate with one binary is `cargo run`, and target/ is what says the first build is behind it", async () => {
    const dir = repo({ "Cargo.toml": crate("game"), "src/main.rs": "fn main() {}" });
    expect(await runPlanOf(dir)).toEqual({ source: "cargo", cwd: dir, shown: "cargo run", command: "cargo run", installed: false });
    mkdirSync(join(dir, "target"));
    expect((await runPlanOf(dir))?.installed).toBe(true);
    // One binary under src/bin, or one [[bin]], is just as unambiguous.
    expect((await runPlanOf(repo({ "Cargo.toml": crate("tools"), "src/bin/editor.rs": "" })))?.command).toBe("cargo run");
    expect((await runPlanOf(repo({ "Cargo.toml": `${crate("tools")}\n[[bin]]\nname = "editor"\npath = "x.rs"\n` })))?.command).toBe("cargo run");
});

test("a crate with several binaries runs its default-run, else the one named for it, else nothing", async () => {
    const files = { "src/main.rs": "", "src/bin/server.rs": "", "src/bin/client/main.rs": "" };
    expect((await runPlanOf(repo({ "Cargo.toml": crate("game"), ...files })))?.command).toBe("cargo run --bin game");
    expect((await runPlanOf(repo({ "Cargo.toml": crate("game", `default-run = "server"`), ...files })))?.command).toBe("cargo run");
    expect(await runPlanOf(repo({ "Cargo.toml": crate("game"), "src/bin/server.rs": "", "src/bin/client.rs": "" }))).toBeUndefined();
    // A library has nothing to run, and autobins off leaves only what [[bin]] names.
    expect(await runPlanOf(repo({ "Cargo.toml": crate("engine"), "src/lib.rs": "" }))).toBeUndefined();
    expect(await runPlanOf(repo({ "Cargo.toml": crate("engine", "autobins = false"), "src/main.rs": "" }))).toBeUndefined();
});

test("a workspace runs its one member with a binary, narrowed by default-members, and refuses to guess between two", async () => {
    const members = {
        "crates/game/Cargo.toml": crate("game"),
        "crates/game/src/main.rs": "",
        "crates/engine/Cargo.toml": crate("engine"),
        "crates/engine/src/lib.rs": "",
    };
    expect((await runPlanOf(repo({ "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n`, ...members })))?.command).toBe("cargo run -p game");
    const two = { ...members, "tools/editor/Cargo.toml": crate("editor"), "tools/editor/src/main.rs": "" };
    expect(await runPlanOf(repo({ "Cargo.toml": `[workspace]\nmembers = ["crates/*", "tools/editor"]\n`, ...two }))).toBeUndefined();
    expect(
        (await runPlanOf(repo({ "Cargo.toml": `[workspace]\nmembers = ["crates/*", "tools/editor"]\ndefault-members = ["tools/editor"]\n`, ...two })))
            ?.command,
    ).toBe("cargo run -p editor");
    expect(
        (await runPlanOf(repo({ "Cargo.toml": `[workspace]\nmembers = ["crates/*", "tools/editor"]\nexclude = ["tools/editor"]\n`, ...two })))
            ?.command,
    ).toBe("cargo run -p game");
    // A root package with a binary of its own is what plain `cargo run` runs, members or not.
    expect((await runPlanOf(repo({ "Cargo.toml": `${crate("launcher")}\n[workspace]\nmembers = ["crates/*"]\n`, "src/main.rs": "", ...members })))?.command).toBe(
        "cargo run",
    );
});

test("a Cargo.toml that is not TOML starts nothing rather than failing the list", async () => {
    expect(await runPlanOf(repo({ "Cargo.toml": "[package\nname = ", "src/main.rs": "" }))).toBeUndefined();
});

test("a repository with none of these has nothing to start", async () => {
    expect(await runPlanOf(repo({ "README.md": "# notes" }))).toBeUndefined();
});
