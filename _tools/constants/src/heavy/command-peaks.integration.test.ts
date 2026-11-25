import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutOf, lineSignature, namedSignature, queuedSignature } from "./command-peaks.mjs";

/* Which repository a command ran in, read off real `.git` pointers in a temporary tree: a plain clone, and a worktree
   whose pointer leads into a shared git directory elsewhere (how this sandbox lays out a conversation's checkout:
   `gitdir: /history/gits/<repo>/worktrees/<name>`, whose `commondir` leads back up). */

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "command-peaks-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

// A clone at `<dir>/work/<repo>`, and a worktree of it at `<dir>/worktrees/<name>/<repo>` sharing `<dir>/gits/<repo>`.
const checkouts = async (repo: string): Promise<{ readonly clone: string; readonly worktree: string }> => {
    const clone = join(dir, "work", repo);
    await mkdir(join(clone, ".git"), { recursive: true });
    const gitDir = join(dir, "gits", repo, "worktrees", "c1");
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, "commondir"), "../..\n");
    const worktree = join(dir, "worktrees", "c1", repo);
    await mkdir(join(worktree, "integra", "src"), { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    return { clone, worktree };
};

test("a repository is named by its git directory, so a clone and a worktree of it are one", async () => {
    const { clone, worktree } = await checkouts("shinobi-society");
    expect(checkoutOf(clone)).toEqual({ repo: "shinobi-society", root: clone, dir: "" });
    expect(checkoutOf(join(worktree, "integra", "src"))).toEqual({ repo: "shinobi-society", root: worktree, dir: "integra/src" });
    // The temporary directory above both is in no checkout.
    expect(checkoutOf(dir)).toBeUndefined();
});

test("queue-run's process names the command it runs, keyed the same from every checkout of the repository", async () => {
    const { clone, worktree } = await checkouts("shinobi-society");
    const proc = join(dir, "proc");
    await mkdir(join(proc, "77"), { recursive: true });
    const argv = ["/usr/bin/bash", "/usr/local/bin/queue-run", "--pool", "cargo", "--label", "cargo-verify", "--", "cargo", "test", "-p", "integra-render", "--lib", "--", "vfx_slots"];
    await writeFile(join(proc, "77", "cmdline"), `${argv.join("\0")}\0`);
    await writeFile(join(proc, "77", "stat"), "77 (bash) S 1 77 77 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 5551212 1000 10 0");
    const fromClone = queuedSignature(77, "cargo-verify", { proc, cwd: clone });
    expect(fromClone).toEqual({ key: "cargo-verify @shinobi-society: cargo test --lib -p integra-render", command: "cargo test --lib -p integra-render", start: 5_551_212 });
    expect(queuedSignature(77, "cargo-verify", { proc, cwd: worktree })).toEqual(fromClone);
    expect(queuedSignature(78, "cargo-verify", { proc, cwd: clone })).toBeUndefined();
});

/* AN AGENT'S WHOLE LINE, for one that grew heavy outside the queue (2026-11-25, the shinobi-society audit: a `python3` at
   3.5 GiB, the repository's own binaries at 2.4 GiB, a game at 1.4 GiB, each from an agent's own Bash line). Staged in a
   repository with a worktree, as /work and /history/gits lay them out. */
describe("a line's signature", () => {
    let root: string;
    let main: string;
    let worktree: string;
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "line-signature-"));
        main = join(root, "work", "shinobi-society");
        worktree = join(root, "history", "worktrees", "c1", "shinobi-society");
        mkdirSync(join(main, ".git", "worktrees", "c1"), { recursive: true });
        mkdirSync(join(main, "tools"), { recursive: true });
        mkdirSync(join(worktree, "tools"), { recursive: true });
        writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "c1")}\n`);
        writeFileSync(join(main, ".git", "worktrees", "c1", "commondir"), "../..\n");
    });
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    test("is the rule `learned`, the repository and folder, and the line's commands, whichever worktree ran it", () => {
        const here = lineSignature("python3 tools/gen.py --all 2>&1 | tail -40", main);
        expect(here).toEqual({ key: "learned @shinobi-society: python3 tools/gen.py --all", command: "python3 tools/gen.py --all" });
        // A leading `cd` is where it ran, never a command; the worktree is the same repository.
        expect(lineSignature(`cd ${worktree} && python3 tools/gen.py --all > /tmp/gen.log`, root)).toEqual(here);
        expect(lineSignature("python3 tools/gen.py --all", join(main, "tools"))?.key).toBe("learned @shinobi-society/tools: python3 tools/gen.py --all");
    });

    test("names every command of it, a binary by its name, and leaves out filters, builtins and the environment", () => {
        expect(lineSignature("cargo build -p game && RUST_LOG=info ./target/debug/integra-assets bake --all | tee /tmp/o; echo done", main)?.command).toBe(
            "cargo build -p game && integra-assets bake --all",
        );
        expect(lineSignature(`${join(worktree, "target/debug/game")} --frames 600`, worktree)?.command).toBe("game --frames 600");
        expect(lineSignature("cd tools\npython3 gen.py", main)?.key).toBe("learned @shinobi-society/tools: python3 gen.py");
        for (const nothing of ["echo hi", "cd /tmp", "FOO=1", "", "export X=1; sleep 5 | tail"]) {
            expect(lineSignature(nothing, main)).toBeUndefined();
        }
    });

    test("names a heredoc by its body, so two scripts fed to the same interpreter are two commands", () => {
        const one = lineSignature("python3 - <<'EOF'\nimport numpy\nprint(1)\nEOF", main);
        const again = lineSignature("python3 - <<'EOF'\nimport numpy\nprint(1)\nEOF", main);
        const other = lineSignature("python3 - <<'EOF'\nprint(2)\nEOF", main);
        expect(one?.command).toMatch(/^python3 - heredoc:[0-9a-f]{10}$/u);
        expect(again).toEqual(one);
        expect(other?.command).not.toBe(one?.command);
    });

    test("a signature named outright takes the start of the queue-run process it names", () => {
        const proc = join(root, "proc");
        mkdirSync(join(proc, "77"), { recursive: true });
        writeFileSync(join(proc, "77", "stat"), "77 (queue-run) S 1 77 77 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 4242 1000 10 0");
        expect(namedSignature(77, "learned @x: python3 a.py", "python3 a.py", { proc })).toEqual({ key: "learned @x: python3 a.py", command: "python3 a.py", start: 4242 });
        expect(namedSignature(77, undefined, "python3 a.py", { proc })).toBeUndefined();
        expect(namedSignature(78, "k", "c", { proc })).toBeUndefined();
    });
});
