// A runner's port previewed through this sandbox: forwarded with its `runner`, kept as a `port:<runner>:<port>` target
// (no list of this sandbox's names it), replaced when asked again, and a refusal leaves nothing behind.
import "@intentic/testing/dom";
import { runnerPortTargetId } from "./previewModel";
import { previewRunnerPort, runnerPreviewTargets } from "./runnerPreviews";

it("names a runner's port apart from this sandbox's own", () => {
    expect(runnerPortTargetId(`rog`, 5173)).toBe(`port:rog:5173`);
});

it("forwards the runner's port and keeps it as a preview target, once however often asked", async () => {
    const asked: unknown[] = [];
    let n = 0;
    const forward = async (input: { port: number; runner: string }) => {
        asked.push(input);
        n += 1;
        return { previewUrl: `https://p${n}.sbx.example.test` };
    };
    const first = await previewRunnerPort(`rog`, 5173, `vite dev`, forward);
    expect(first).toMatchObject({ id: `port:rog:5173`, kind: `port`, detail: `vite dev`, url: `https://p1.sbx.example.test`, running: true, startable: false });
    await previewRunnerPort(`rog`, 5173, undefined, forward);
    expect(asked).toEqual([
        { port: 5173, runner: `rog` },
        { port: 5173, runner: `rog` },
    ]);
    expect(runnerPreviewTargets().map((target) => [target.id, target.url, target.detail])).toEqual([[`port:rog:5173`, `https://p2.sbx.example.test`, `rog`]]);
});

it("keeps nothing for a port the runner refuses", async () => {
    const before = runnerPreviewTargets().length;
    await expect(previewRunnerPort(`rog`, 22, undefined, async () => { throw new Error(`On the runner "rog": nothing is listening`); })).rejects.toThrow(`nothing is listening`);
    expect(runnerPreviewTargets()).toHaveLength(before);
});
