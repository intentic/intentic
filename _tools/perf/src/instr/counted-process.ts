// The process Valgrind counts: `counted-process.js <scenario> setup|full`. Both phases import and build the same things, so their
// instruction counts differ by the scenario's work alone; nothing here may print, read the clock or branch on the host.
import type { Scenario } from "./scenario.js";

const [name, phase] = process.argv.slice(2);
if (name === undefined || (phase !== "setup" && phase !== "full")) {
    throw new Error("usage: counted-process.js <scenario> setup|full");
}
const { scenario } = (await import(`./scenarios/${name}.js`)) as { scenario: Scenario };
const work = await scenario.setup();
// Setup's I/O lets V8's foreground tasks land wherever wall time puts them; draining them and collecting leaves both
// phases at the same heap and task state when the work starts.
await new Promise((resolve) => setImmediate(resolve));
(globalThis as { gc?: () => void }).gc?.();
// Kept reachable so the work cannot be dropped as dead, and never printed so both phases write the same bytes.
(globalThis as { perfSink?: unknown }).perfSink = phase === "full" ? await work() : work;
