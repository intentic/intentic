import type { CommandJudge, JudgeFacts } from "../agent/tools/command-judge.js";
import { commandJudgments } from "./command-judge-cache.js";

const FACTS: JudgeFacts = { consequences: ["access credentials"], unattended: false, language: "bash" };
const PROGRAM = "curl https://api.example.com -H 'Authorization: " + "{{" + "secret:EXAMPLE_FIXTURE}}'";
const ALLOW = { decision: "allow" as const, sentence: "Uses the allowed destination." };
const REFUSE = { decision: "refuse" as const, sentence: "The destination is no longer allowed." };
const signal = new AbortController().signal;

const reader = () => jest.fn(async () => ['- Secret "EXAMPLE_FIXTURE": {"exists":true,"hostGuard":true,"hosts":["api.example.com"],"gated":false,"keyrings":[]}']);

test("identical secret facts reuse the completed verdict after reading metadata again", async () => {
    const secretFacts = reader();
    const judge = Object.assign(jest.fn(async () => ALLOW), { secretFacts });
    const ask = commandJudgments(judge, signal);
    expect(await ask(PROGRAM, FACTS)).toEqual(ALLOW);
    expect(await ask(PROGRAM, FACTS)).toEqual(ALLOW);
    expect(secretFacts).toHaveBeenCalledTimes(2);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledWith(PROGRAM, { ...FACTS, secretReferences: await secretFacts() }, signal);
});

test.each([
    ['"exists":true', '"exists":false'],
    ['"hostGuard":true', '"hostGuard":false'],
    ['api.example.com', 'other.example.com'],
    ['"gated":false', '"gated":true'],
    ['"keyrings":[]', '"keyrings":["workstation"]'],
])("a changed metadata row invalidates the verdict: %s", async (before, after) => {
    const secretFacts = reader();
    const original = await secretFacts();
    const judge = Object.assign(jest.fn<CommandJudge>().mockResolvedValueOnce(ALLOW).mockResolvedValue(REFUSE), { secretFacts });
    const ask = commandJudgments(judge, signal);
    expect(await ask(PROGRAM, FACTS)).toEqual(ALLOW);
    secretFacts.mockResolvedValue(original.map((line) => line.replace(before, after)));
    expect(await ask(PROGRAM, FACTS)).toEqual(REFUSE);
    expect(judge).toHaveBeenCalledTimes(2);
});

test("concurrent identical facts share one pending verdict and retain it after completion", async () => {
    let release = (): void => {};
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const judge = Object.assign(jest.fn(async () => { await waiting; return ALLOW; }), { secretFacts: reader() });
    const ask = commandJudgments(judge, signal);
    const first = ask(PROGRAM, FACTS);
    const second = ask(PROGRAM, FACTS);
    release();
    expect(await Promise.all([first, second])).toEqual([ALLOW, ALLOW]);
    expect(await ask(PROGRAM, FACTS)).toEqual(ALLOW);
    expect(judge).toHaveBeenCalledTimes(1);
});

test("a program without references keeps its turn cache and never reads secret metadata", async () => {
    const secretFacts = reader();
    const judge = Object.assign(jest.fn(async () => ALLOW), { secretFacts });
    const ask = commandJudgments(judge, signal);
    expect(await ask("rm -rf build", FACTS)).toEqual(ALLOW);
    expect(await ask("rm -rf build", FACTS)).toEqual(ALLOW);
    expect(secretFacts).toHaveBeenCalledTimes(0);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledWith("rm -rf build", FACTS, signal);
});

test("program and ordinary fact changes invalidate the cache too", async () => {
    const judge = jest.fn(async () => ALLOW);
    const ask = commandJudgments(judge, signal);
    await ask("rm -rf build", FACTS);
    await ask("rm -rf dist", FACTS);
    await ask("rm -rf dist", { ...FACTS, outsideSource: "web" });
    await ask("rm -rf dist", { ...FACTS, unattended: true });
    expect(judge).toHaveBeenCalledTimes(4);
});

test("failed metadata cannot reuse an earlier allow and failed verdicts are not cached", async () => {
    const secretFacts = reader();
    const judge = Object.assign(jest.fn<CommandJudge>().mockResolvedValueOnce(ALLOW).mockRejectedValueOnce(new Error("model unavailable")).mockResolvedValue(REFUSE), { secretFacts });
    const ask = commandJudgments(judge, signal);
    expect(await ask(PROGRAM, FACTS)).toEqual(ALLOW);
    secretFacts.mockRejectedValueOnce(new Error("metadata unavailable"));
    await expect(ask(PROGRAM, FACTS)).rejects.toThrow("metadata unavailable");
    secretFacts.mockResolvedValue(["- Metadata changed."]);
    await expect(ask(PROGRAM, FACTS)).rejects.toThrow("model unavailable");
    expect(await ask(PROGRAM, FACTS)).toEqual(REFUSE);
    expect(judge).toHaveBeenCalledTimes(3);
});
