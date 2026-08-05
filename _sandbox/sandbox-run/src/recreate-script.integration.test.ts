import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

/* recreate.sh's channel + rollback record.
 *
 * Two kinds of assertion here, and the split is deliberate. The record's LOGIC is extracted and run under a
 * real `sh`, because "does a rollback swap the pair or append to it" is a behavioural question and a regex
 * over the source cannot answer it. The ORDERING — that the record is written before `docker rm -f` — can only
 * be checked against the source, but it is the single most important property in the file: the rm is what
 * makes the replaced image unknowable, so a record written after it would be a record of nothing, and the
 * rollback button would be permanently dead in exactly the situation it exists for. */

const SCRIPT = new URL("../../../_site/site/public/scripts/recreate.sh", import.meta.url);
const source = readFileSync(SCRIPT, "utf8");

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the rollback record is written before the container is destroyed", () => {
    const write = source.indexOf('} >"${RECORD}.tmp" && mv "${RECORD}.tmp" "$RECORD"');
    const destroy = source.indexOf('docker rm -f "$CONTAINER" >/dev/null\n');
    expect(write).toBeGreaterThan(0);
    expect(destroy).toBeGreaterThan(0);
    expect(write).toBeLessThan(destroy);
});

test("every mode the script dispatches has an arm that produces a target image", () => {
    // A mode parsed but never built would fail late, past the point where the sandbox is already gone.
    for (const mode of ["rebuild", "update", "rollback", "dev"]) {
        expect(source, mode).toMatch(new RegExp(`MODE="${mode}"|\\b${mode}\\)`));
    }
    // update and rollback share one build arm — the difference is only which tag REGISTRY_IMAGE holds.
    expect(source).toContain("update | rollback)");
});

test("--channel needs a tag and an unknown flag is refused rather than read as an overlay hash", () => {
    const run = (...args: string[]): { status: number; stderr: string } => {
        try {
            execFileSync("sh", [new URL(SCRIPT).pathname, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            return { status: 0, stderr: "" };
        } catch (error) {
            const failure = error as { status?: number; stderr?: string };
            return { status: failure.status ?? -1, stderr: failure.stderr ?? "" };
        }
    };
    expect(run("slug", "--channel").stderr).toContain("--channel needs a tag");
    expect(run("slug", "--nonsense").stderr).toContain("unknown option");
    // No arguments still prints the usage the platform's one-liners are built from.
    expect(run().stderr).toContain("--rollback");
});

/* The record's own arithmetic, lifted out and run. `previous` is what a rollback returns to, and the property
 * that matters is that a rollback SWAPS rather than appends: one button with no "how far back" control has to
 * be its own undo, or pressing it twice walks backwards through history with no way forward. */
const recordScript = (mode: string, channel: string, base: string, previous: string): string => `
set -eu
RECORD="$1"
MODE=${mode}
CHANNEL=${channel}
BASE_IMAGE=${base}
PREVIOUS_IMAGE=${previous}
record_value() {
    [ -f "$RECORD" ] || return 0
    sed -n "s/^$1=//p" "$RECORD" | tail -n 1
}
${source.slice(source.indexOf('if [ "$MODE" = "rollback" ]; then'), source.indexOf('} >"${RECORD}.tmp" && mv "${RECORD}.tmp" "$RECORD"') + 50)}
cat "$RECORD"
`;

const runRecord = (mode: string, channel: string, base: string, previous: string, seed?: string): Record<string, string> => {
    const dir = mkdtempSync(join(tmpdir(), "intentic-recreate-"));
    dirs.push(dir);
    const record = join(dir, "sandbox-x.channel");
    if (seed !== undefined) {
        writeFileSync(record, seed);
    }
    const script = join(dir, "record.sh");
    writeFileSync(script, recordScript(mode, channel, base, previous));
    const out = execFileSync("sh", [script, record], { encoding: "utf8" });
    return Object.fromEntries(
        out
            .split("\n")
            .filter((line) => line.includes("="))
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
};

test("an update records what it replaced, and a rollback swaps the pair so pressing it twice returns", () => {
    const updated = runRecord("update", "stable", "img:2", "img:1");
    expect(updated).toEqual({ channel: "stable", current: "img:2", previous: "img:1" });

    // Rolling back onto img:1: `previous` becomes the image we are leaving, so the next rollback goes forward.
    const rolledBack = runRecord("rollback", "stable", "img:1", "img:2", "channel=stable\ncurrent=img:2\nprevious=img:1\n");
    expect(rolledBack).toEqual({ channel: "stable", current: "img:1", previous: "img:2" });
});

test("a swap that does not move the base leaves the rollback target alone", () => {
    // A rebuild (same base, new overlay) must not overwrite `previous` with the image we are already on —
    // that would quietly turn the rollback button into a no-op.
    const rebuilt = runRecord("rebuild", "stable", "img:2", "img:2", "channel=stable\ncurrent=img:2\nprevious=img:1\n");
    expect(rebuilt["previous"]).toBe("img:1");
});

test("a first-ever swap records no rollback target rather than inventing one", () => {
    const fresh = runRecord("update", "stable", "img:1", "");
    expect(fresh["previous"]).toBeUndefined();
    expect(fresh).toMatchObject({ channel: "stable", current: "img:1" });
});
