import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { afterEach, expect, test } from "vitest";

/* recreate.sh is a bootstrap shim: the flow lives in the ic CLI (_sandbox/ic), and the script's one job is
 * mapping every argument shape the platform's one-liners ever handed out onto ic verbs. That mapping is the
 * compatibility contract: a pasted command from an old card must keep working, so it is exercised here
 * under a real `sh` with a stand-in ic that records its argv.
 *
 * The record-before-rm ordering that used to be checked against this script moved to the Rust source with
 * the logic itself; the source-order check below follows it there, because it is still the single most
 * important property of the flow: the rm is what makes the replaced image unknowable, so a record written
 * after it would be a record of nothing, and the rollback button would be permanently dead in exactly the
 * situation it exists for. (The record's arithmetic: rollback swaps the pair, an unchanged base keeps the
 * target, is tested in Rust: _sandbox/ic/src/sandbox/recreate.rs.) */

const SCRIPT = join(repoRoot(import.meta.url), "_site/site/public/scripts/recreate.sh");
const RECREATE_RS = join(repoRoot(import.meta.url), "_sandbox/ic/src/sandbox/recreate.rs");

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the rollback record is written before the container is destroyed", () => {
    const source = readFileSync(RECREATE_RS, "utf8");
    const write = source.indexOf("record::write(");
    const destroy = source.indexOf('docker::quiet(&["rm", "-f", &container])');
    expect(write).toBeGreaterThan(0);
    expect(destroy).toBeGreaterThan(0);
    expect(write).toBeLessThan(destroy);
});

/* Run the shim with a stand-in ic on IC_BIN that prints its argv: no network, no docker. */
const shimArgs = (...args: string[]): { status: number; out: string; err: string } => {
    const dir = mkdtempSync(join(tmpdir(), "intentic-recreate-"));
    dirs.push(dir);
    const fake = join(dir, "fake-ic");
    writeFileSync(fake, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    chmodSync(fake, 0o755);
    try {
        const out = execFileSync("sh", [SCRIPT, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, IC_BIN: fake },
        });
        return { status: 0, out, err: "" };
    } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { status: failure.status ?? -1, out: failure.stdout ?? "", err: failure.stderr ?? "" };
    }
};

const argv = (result: { out: string }): string[] => result.out.split("\n").filter((line) => line !== "");

test("every one-liner shape the platform ever handed out maps onto its ic verb", () => {
    // The Environment card's rebuild command: <slug> <sha256>.
    const hash = "a".repeat(64);
    expect(argv(shimArgs("abc123", hash))).toEqual(["sandbox", "rebuild", "abc123", hash]);
    // The Sandbox card's update command: <slug> alone.
    expect(argv(shimArgs("abc123"))).toEqual(["sandbox", "update", "abc123"]);
    // A channel move, a rollback, and the dev loop (slug optional).
    expect(argv(shimArgs("abc123", "--channel", "core-stable"))).toEqual(["sandbox", "update", "abc123", "--channel", "core-stable"]);
    expect(argv(shimArgs("abc123", "--rollback"))).toEqual(["sandbox", "rollback", "abc123"]);
    expect(argv(shimArgs("--dev"))).toEqual(["sandbox", "dev"]);
    expect(argv(shimArgs("--dev", "abc123"))).toEqual(["sandbox", "dev", "abc123"]);
});

test("--channel needs a tag and an unknown flag is refused rather than read as an overlay hash", () => {
    expect(shimArgs("slug", "--channel").err).toContain("--channel needs a tag");
    expect(shimArgs("slug", "--nonsense").err).toContain("unknown option");
});
