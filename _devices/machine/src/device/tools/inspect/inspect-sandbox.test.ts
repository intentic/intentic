import { icInspectArgs, icLacksInspect, INSPECT_READS, MAX_INSPECT_ARG_LENGTH, MAX_INSPECT_ARGS } from "./inspect-sandbox.js";

// inspect_sandbox runs only reads, and the same list `ic sandbox inspect` holds them to (_sandbox/ic/src/sandbox/inspect.rs
// tests the same cases on that side): a refusal here is said before ic is asked, and names what is allowed.

const ALLOWED = "Allowed: agents ls, show, find or bundle; diagnostics errors, slow, turns, resources, restarts, timeline or failures; or either one's --help.";

test("each read becomes the argv ic takes, the command's words after a `--` so a leading flag stays the command's", () => {
    expect(icInspectArgs("work", "agents", ["show", "glad-falcon-puep", "--transcript", "--last", "40"])).toEqual([
        "sandbox",
        "inspect",
        "work",
        "agents",
        "--",
        "show",
        "glad-falcon-puep",
        "--transcript",
        "--last",
        "40",
    ]);
    expect(icInspectArgs("work", "diagnostics", ["timeline", "glad-falcon-puep"])).toEqual([
        "sandbox",
        "inspect",
        "work",
        "diagnostics",
        "--",
        "timeline",
        "glad-falcon-puep",
    ]);
    expect(icInspectArgs("work", "agents", ["--help"])).toEqual(["sandbox", "inspect", "work", "agents", "--", "--help"]);
    expect(icInspectArgs("work", "diagnostics", ["-h"])).toEqual(["sandbox", "inspect", "work", "diagnostics", "--", "-h"]);
    // Words stay whole: argv, never a shell's line to split.
    expect(icInspectArgs("work", "agents", ["find", "it's; rm -rf /"])).toEqual([
        "sandbox",
        "inspect",
        "work",
        "agents",
        "--",
        "find",
        "it's; rm -rf /",
    ]);
    for (const verb of INSPECT_READS.agents) {
        expect(icInspectArgs("work", "agents", [verb, "x"]).slice(5)).toEqual([verb, "x"]);
    }
    for (const verb of INSPECT_READS.diagnostics) {
        expect(icInspectArgs("work", "diagnostics", [verb, "--since", "60", "--json"]).slice(5)).toEqual([verb, "--since", "60", "--json"]);
    }
});

test("a verb that writes or reaches elsewhere is refused, naming what is allowed", () => {
    for (const verb of [
        "message",
        "resume",
        "delegate",
        "spawn",
        "wait",
        "send",
        "answer",
        "cancel",
        "merge",
        "settle",
        "links",
        "providers",
        "list",
    ]) {
        expect(() => icInspectArgs("work", "agents", [verb, "x"])).toThrow(`inspect_sandbox does not run agents ${verb}: it only reads. ${ALLOWED}`);
    }
    // One command's read is not the other's.
    expect(() => icInspectArgs("work", "diagnostics", ["show", "x"])).toThrow(/does not run diagnostics show/);
    expect(() => icInspectArgs("work", "agents", ["timeline", "x"])).toThrow(/does not run agents timeline/);
    // A flag first is not a verb, and help takes nothing after it.
    expect(() => icInspectArgs("work", "agents", ["--json", "ls"])).toThrow(/does not run agents --json/);
    expect(() => icInspectArgs("work", "agents", ["--help", "message"])).toThrow(`agents --help takes nothing after it. ${ALLOWED}`);
});

test("only agents and diagnostics run, and each needs a verb", () => {
    for (const command of ["", "sh", "bash", "cat", "node", "Agents", "agents;id"]) {
        expect(() => icInspectArgs("work", command, ["ls"])).toThrow(ALLOWED);
    }
    expect(() => icInspectArgs("work", "agents", [])).toThrow(
        `inspect_sandbox needs to know what agents should read: its first argument is the verb. ${ALLOWED}`,
    );
    expect(() => icInspectArgs("work", "diagnostics", [""])).toThrow(/needs to know what diagnostics should read/);
});

test("--on and --out are refused in every spelling and place, and flags that only start alike are not", () => {
    for (const [command, args] of [
        ["agents", ["ls", "--on", "work"]],
        ["agents", ["show", "x", "--on=work"]],
        ["diagnostics", ["errors", "--on"]],
        ["agents", ["find", "--", "--on"]],
    ] as const) {
        expect(() => icInspectArgs("work", command, args)).toThrow(/does not take --on \(that reads a linked sandbox\)/);
    }
    for (const args of [
        ["bundle", "x", "--out", "/tmp/x.json"],
        ["bundle", "x", "--out=/tmp/x.json"],
    ]) {
        expect(() => icInspectArgs("work", "agents", args)).toThrow(/writes no file, so it does not take --out/);
    }
    expect(icInspectArgs("work", "agents", ["ls", "--owner", "me"])).toContain("--owner");
    expect(icInspectArgs("work", "agents", ["find", "--online"])).toContain("--online");
    expect(icInspectArgs("work", "diagnostics", ["errors", "--output"])).toContain("--output");
});

test("a slug ic would read as a flag or a path, and a read past the caps, are refused before ic runs", () => {
    for (const slug of ["--help", "-x", "", "../x", "a/b", "a b"]) {
        expect(() => icInspectArgs(slug, "agents", ["ls"])).toThrow(`"${slug}" is not a sandbox slug; list_sandboxes names them.`);
    }
    expect(icInspectArgs("work", "agents", ["find", ...Array.from({ length: MAX_INSPECT_ARGS - 1 }, () => "x")])).toHaveLength(5 + MAX_INSPECT_ARGS);
    expect(() => icInspectArgs("work", "agents", ["find", ...Array.from({ length: MAX_INSPECT_ARGS }, () => "x")])).toThrow(/at most 24 arguments/);
    expect(icInspectArgs("work", "agents", ["find", "x".repeat(MAX_INSPECT_ARG_LENGTH)])).toHaveLength(7);
    expect(() => icInspectArgs("work", "agents", ["find", "x".repeat(MAX_INSPECT_ARG_LENGTH + 1)])).toThrow(/at most 500 characters/);
});

test("an ic from before `inspect` is told apart from a read that failed", () => {
    expect(icLacksInspect("error: unrecognized subcommand 'inspect'\n\nUsage: ic sandbox <COMMAND>\n\nFor more information, try '--help'.")).toBe(
        true,
    );
    expect(icLacksInspect("error: work is not running, so its records cannot be read.")).toBe(false);
    expect(icLacksInspect('agents: no conversation matches "inspect"')).toBe(false);
});
