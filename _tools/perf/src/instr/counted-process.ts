// The process Valgrind counts: `counted-process.js <scenario> setup|full`. Both phases import and build the same things, so their
// instruction counts differ by the scenario's work alone; nothing here may print, read the clock or branch on the host.
import type { Scenario } from "./scenario.js";

const [name, phase] = process.argv.slice(2);
if (name === undefined || (phase !== "setup" && phase !== "full")) {
    throw new Error("usage: counted-process.js <scenario> setup|full");
}
// Code under test can read the clock itself: code-read's tokenizer stops at a wall-time budget, and Shiki's per-line limit
// checks Date.now in its loop. Under Valgrind that budget can run out partway through a setup, and then the two phases
// start their work from different states, so the difference between them moves with the host's load. A clock that never
// advances keeps every budget unspent.
const FROZEN_EPOCH = Date.UTC(2026, 0, 1);
Object.defineProperty(Date, "now", { value: () => FROZEN_EPOCH });
Object.defineProperty(performance, "now", { value: () => 0 });
const { scenario } = (await import(`./scenarios/${name}.js`)) as { scenario: Scenario };
const work = await scenario.setup();
// Setup's I/O lets V8's foreground tasks land wherever wall time puts them; draining them and collecting leaves both
// phases at the same heap and task state when the work starts.
await new Promise((resolve) => setImmediate(resolve));
(globalThis as { gc?: () => void }).gc?.();
// Kept reachable so the work cannot be dropped as dead, and never printed so both phases write the same bytes.
(globalThis as { perfSink?: unknown }).perfSink = phase === "full" ? await work() : work;
