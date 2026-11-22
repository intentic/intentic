import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutOf, queuedSignature } from "./command-peaks.mjs";

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
