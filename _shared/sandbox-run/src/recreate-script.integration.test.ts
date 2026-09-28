import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

// recreate.sh maps old one-liner argument shapes onto ic verbs, tested under a real `sh` with a stand-in ic. Also
// checks recreate.rs writes the rollback record before destroying the container: a late write leaves rollback dead.

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

// The desktop app's doors onto ic's own verbs: power and shape name the sandbox, the listing does not.
test("power, shape and the listing reach ic's own verbs, with ic's flags forwarded verbatim", () => {
    expect(argv(shimArgs("abc123", "--restart"))).toEqual(["sandbox", "restart", "abc123"]);
    expect(argv(shimArgs("abc123", "--start"))).toEqual(["sandbox", "start", "abc123"]);
    expect(argv(shimArgs("abc123", "--stop"))).toEqual(["sandbox", "stop", "abc123"]);
    expect(argv(shimArgs("abc123", "--shape", "--memory", "12g", "--when", "next-restart"))).toEqual([
        "sandbox",
        "shape",
        "abc123",
        "--memory",
        "12g",
        "--when",
        "next-restart",
    ]);
    expect(argv(shimArgs("abc123", "--shape", "--forget"))).toEqual(["sandbox", "shape", "abc123", "--forget"]);
    expect(argv(shimArgs("--list"))).toEqual(["sandbox", "list", "--json"]);
});

// The ways back and the checks around an update, each naming the sandbox. --versions and --watch forward ic's own
// flags (--json) like --shape does; the rest take none.
test("rollback-to, versions, watch, backup and doctor reach ic's own verbs", () => {
    expect(argv(shimArgs("abc123", "--rollback-to", "1.200.0"))).toEqual(["sandbox", "rollback", "abc123", "--to", "1.200.0"]);
    expect(argv(shimArgs("abc123", "--rollback-to", "ghcr.io/intentic/sandbox:1.200.0"))).toEqual([
        "sandbox",
        "rollback",
        "abc123",
        "--to",
        "ghcr.io/intentic/sandbox:1.200.0",
    ]);
    expect(argv(shimArgs("abc123", "--versions"))).toEqual(["sandbox", "versions", "abc123"]);
    expect(argv(shimArgs("abc123", "--versions", "--json"))).toEqual(["sandbox", "versions", "abc123", "--json"]);
    expect(argv(shimArgs("abc123", "--watch"))).toEqual(["sandbox", "watch", "abc123"]);
    expect(argv(shimArgs("abc123", "--watch", "--json"))).toEqual(["sandbox", "watch", "abc123", "--json"]);
    expect(argv(shimArgs("abc123", "--backup"))).toEqual(["sandbox", "backup", "abc123"]);
    expect(argv(shimArgs("abc123", "--doctor"))).toEqual(["sandbox", "doctor", "abc123"]);
});

// The desktop app's Remove: into ic's trash, unasked because the app has already asked, and never `--now`, which is the
// one spelling of remove that deletes the data on the spot.
test("--remove moves the sandbox to ic's trash without a prompt, never deleting it outright", () => {
    expect(argv(shimArgs("abc123", "--remove"))).toEqual(["sandbox", "remove", "abc123", "-y"]);
});

test("--channel needs a tag and an unknown flag is refused rather than read as an overlay hash", () => {
    expect(shimArgs("slug", "--channel").err).toContain("--channel needs a tag");
    expect(shimArgs("slug", "--rollback-to").err).toContain("--rollback-to needs a version or an image");
    expect(shimArgs("slug", "--nonsense").err).toContain("unknown option");
});
