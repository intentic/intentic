import { askIcServe, type ServedAnswer } from "./ic-serve.js";
import { type IcRun, lineSplitter, runIc, spanOf } from "../sandboxes.js";

// A served answer as runIc reports a run: both streams as one, line by line, the empty remainder after a final newline
// no line (lineSplitter). Pure.
export const servedRun = (served: ServedAnswer): IcRun => {
    const lines: string[] = [];
    const split = lineSplitter((line) => lines.push(line));
    split.push(served.output);
    split.end();
    return { code: served.code, output: lines.join("\n") };
};

// One of the reads a background round repeats (`engine disk --json`): the resident ic's answer when it has one
// (ic-serve.ts), else runIc as before. Bounded by the same deadline either way, and a timeout says so the same way.
export const runIcRead = async (args: readonly string[], deadlineMs: number): Promise<IcRun> => {
    const served = await askIcServe(args, deadlineMs);
    if (served === "timeout") {
        return { code: 1, output: `ic did not finish within ${spanOf(deadlineMs)} and was stopped.`, timedOut: true };
    }
    return served === undefined ? await runIc(args, () => undefined, {}, { deadlineMs }) : servedRun(served);
};
