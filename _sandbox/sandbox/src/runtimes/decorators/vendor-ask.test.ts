import { unstubbed } from "@intentic/testing";
import type { CommandGuard, CommandWhere } from "../../guard/command-guard.js";
import { answerVendorAsk, askCwdOf, askProgramOf, CONSULT_FAILED, type VendorAsk, VendorToolInputSchema } from "./vendor-ask.js";

// The one answer every vendor CLI's permission ask gets, whatever wire it came over. The gate is a stub: what is under
// test is when the rulebook is consulted and what the answer may promise, not the rulebook.

const ASK: VendorAsk = { tool: "Bash", program: "git push origin main", cwd: "/srv/repo/sub", canRefuse: true };

// A gate that enforces and answers every consult with `verdict`, recording where each consulted command runs.
const recording = (verdict: { allow: true } | { allow: false; reason: string }) => {
    const where: (CommandWhere | undefined)[] = [];
    const gate = unstubbed<CommandGuard>("gate", {
        enforcing: true,
        async *consult (_program, _subject, at) {
            where.push(at);
            yield* [];
            return verdict;
        },
    });
    return { gate, where };
};

test("the command is read from the first of command, cmd, script, code and input, then the fallback when not blank", () => {
    const read = (raw: unknown, fallback?: string | null): string | undefined => askProgramOf(VendorToolInputSchema.parse(raw), fallback);
    expect(read({ command: "  ", cmd: 42, script: "make deploy", input: "make test" })).toBe("make deploy");
    expect(read({ code: "rm -rf /" }, "Run code")).toBe("rm -rf /");
    expect(read({}, 'Run "ls"')).toBe('Run "ls"');
    expect(read({}, "   ")).toBeUndefined();
    expect(read({}, null)).toBeUndefined();
});

test("a hostile input shape reads as naming nothing rather than throwing", () => {
    for (const raw of [null, undefined, 42, "a string", [], { command: 7 }, { command: "" }]) {
        const input = VendorToolInputSchema.parse(raw);
        expect(askProgramOf(input)).toBeUndefined();
        expect(askCwdOf(input)).toBeUndefined();
    }
});

test("the directory is the one the input names, read against the base when relative, else the base", () => {
    const where = (raw: unknown, base?: string): string | undefined => askCwdOf(VendorToolInputSchema.parse(raw), base);
    expect(where({ cwd: "/srv/repo/video" }, "/srv/repo")).toBe("/srv/repo/video");
    expect(where({ workdir: "video" }, "/srv/repo")).toBe("/srv/repo/video");
    expect(where({ dir_path: "/elsewhere" })).toBe("/elsewhere");
    expect(where({}, "/srv/repo")).toBe("/srv/repo");
    // Relative to nothing known: the gate's own cwd is safer than a guess.
    expect(where({ directory: "video" })).toBeUndefined();
});

test("with no gate, or one that does not enforce, the standing yes may be a lasting one and nothing is consulted", async () => {
    expect(await answerVendorAsk(undefined, ASK)).toEqual({ allow: true, lasting: true });
    const lax = unstubbed<CommandGuard>("gate", { enforcing: false });
    expect(await answerVendorAsk({ gate: lax, push: () => {} }, ASK)).toEqual({ allow: true, lasting: true });
});

test("an enforcing gate never gets a lasting yes, even for an ask it is not consulted on", async () => {
    const strict = unstubbed<CommandGuard>("gate", { enforcing: true });
    const judge = { gate: strict, push: () => {} };
    expect(await answerVendorAsk(judge, { ...ASK, program: undefined })).toEqual({ allow: true, lasting: false });
    expect(await answerVendorAsk(judge, { ...ASK, canRefuse: false })).toEqual({ allow: true, lasting: false });
});

test("a command the rulebook allows is allowed for this call only, and the check is told where it runs", async () => {
    const { gate, where } = recording({ allow: true });
    expect(await answerVendorAsk({ gate, push: () => {} }, ASK)).toEqual({ allow: true, lasting: false });
    expect(where).toEqual([{ cwd: "/srv/repo/sub" }]);
});

test("a refusal carries the rulebook's reason", async () => {
    const { gate } = recording({ allow: false, reason: "Discards commits the remote has." });
    expect(await answerVendorAsk({ gate, push: () => {} }, ASK)).toEqual({ allow: false, reason: "Discards commits the remote has." });
});

test("a check that throws is a refusal, never an allow, and the hold is released either way", async () => {
    const holds: string[] = [];
    const broken = unstubbed<CommandGuard>("gate", {
        enforcing: true,
        consult: () => {
            throw new Error("the card store is gone");
        },
    });
    const hold = (): (() => void) => {
        holds.push("held");
        return () => void holds.push("released");
    };
    expect(await answerVendorAsk({ gate: broken, push: () => {}, hold }, ASK)).toEqual({ allow: false, reason: CONSULT_FAILED });
    expect(holds).toEqual(["held", "released"]);
});
