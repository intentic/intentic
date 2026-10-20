import type { ResultValue } from "../../child-result.js";
import { readLiteral, runScript, type ScriptHost } from "../script-vm.js";
import { splitScript } from "../script-source.js";

// A workflow script in its sandbox: what it can call, what it cannot reach, and how it ends.

interface Recorded {
    readonly calls: { readonly prompt: string; readonly options: ResultValue }[];
    readonly phases: string[];
    readonly logs: string[];
}

const host = (answer: (prompt: string, options: ResultValue) => Promise<ResultValue> = async (prompt) => `did: ${prompt}`): ScriptHost & Recorded => {
    const recorded: Recorded = { calls: [], phases: [], logs: [] };
    return {
        ...recorded,
        agent: async (prompt, options) => {
            recorded.calls.push({ prompt, options });
            return answer(prompt, options);
        },
        phase: (title) => void recorded.phases.push(title),
        log: (line) => void recorded.logs.push(line),
    };
};

const run = (body: string, on: ScriptHost, args: ResultValue = null, signal = new AbortController().signal): ReturnType<typeof runScript> =>
    runScript(body, args, on, signal, { memoryBytes: 16 * 1024 * 1024, stackBytes: 256 * 1024, syncMs: 200 });

describe("a script's own source", () => {
    it("is its meta literal and the body after it", () => {
        expect(splitScript('// A review.\nexport const meta = { name: "review", description: "a { brace in a string }" };\nreturn 1;')).toEqual({
            metaLiteral: '{ name: "review", description: "a { brace in a string }" }',
            body: "\nreturn 1;",
        });
    });

    it("is refused without a meta literal, or with an import past it", () => {
        expect(splitScript("return 1;")).toEqual({
            fault: 'A workflow script opens with `export const meta = { name: "…", description: "…" }`, a plain object literal.',
        });
        expect(splitScript('export const meta = { name: "x" };\nimport fs from "node:fs";')).toMatchObject({ fault: expect.stringContaining("no imports or exports") });
    });

    it("reads its meta as a value, and refuses one that calls anything", async () => {
        expect(await readLiteral('{ name: "review", phases: [{ title: "Review" }] }')).toEqual({ value: { name: "review", phases: [{ title: "Review" }] } });
        expect(await readLiteral("{ name: agent('x') }")).toMatchObject({ fault: expect.stringContaining("agent") });
    });
});

describe("a script's run", () => {
    it("fans its calls out, and returns what its body returns", async () => {
        const on = host();
        const ended = await run(
            `phase("Review");
             const found = await parallel([() => agent("a", { label: "one" }), () => agent("b")]);
             log("found", found.length);
             return { found };`,
            on,
        );
        expect(ended).toEqual({ value: { found: ["did: a", "did: b"] } });
        expect(on.calls).toEqual([
            { prompt: "a", options: { label: "one" } },
            { prompt: "b", options: {} },
        ]);
        expect(on.phases).toEqual(["Review"]);
        expect(on.logs).toEqual(["found 2"]);
    });

    it("hands a pipeline's stages each other's results, a failed item to null with the reason logged", async () => {
        const on = host(async (prompt) => {
            if (prompt === "check 2") {
                throw new Error("refused");
            }
            return prompt.toUpperCase();
        });
        const ended = await run(`return await pipeline([1, 2], (n) => agent("check " + n), (checked) => agent("then " + checked));`, on);
        expect(ended).toEqual({ value: ["THEN CHECK 1", null] });
        expect(on.logs).toEqual(["pipeline: refused"]);
    });

    it("sees its args, and no clock, randomness, module or process", async () => {
        const ended = await run(
            "return { args, date: typeof Date, random: typeof Math.random, require: typeof require, process: typeof process };",
            host(),
            { files: ["a.ts"] },
        );
        expect(ended).toEqual({ value: { args: { files: ["a.ts"] }, date: "undefined", random: "undefined", require: "undefined", process: "undefined" } });
    });

    it("ends on an error the script did not catch, in its words", async () => {
        expect(await run(`await agent("x"); throw new Error("no findings to verify");`, host())).toEqual({ error: "no findings to verify" });
    });

    it("stops a loop that never yields rather than freezing the daemon", async () => {
        const ended = await run("while (true) {}", host());
        expect(ended).toMatchObject({ error: expect.stringContaining("interrupted") });
    });

    it("is stopped by its signal while a call is still out", async () => {
        const stop = new AbortController();
        const never = host(() => new Promise<ResultValue>(() => {}));
        const ending = run(`await agent("forever"); return 1;`, never, null, stop.signal);
        await new Promise((resolve) => setTimeout(resolve, 20));
        stop.abort();
        expect(await ending).toEqual({ error: "The workflow was stopped." });
    });
});
