import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { packageRoot } from "@intentic/constants/node";
import { STATE_PLAN_FORMAT, type StatePlan, StatePlanSchema, type StateStatus, StateStatusSchema } from "./state-plan.js";

// The documents `ic` reads by field name, spelled once here: each golden file under golden/ is one of these examples
// as JSON, and the Rust tests (_sandbox/ic/src/sandbox/preflight.rs, health.rs) parse the same files. A change here
// that the committed file does not carry fails, naming the file; `INTENTIC_WRITE_GOLDEN=1` rewrites them, and the Rust
// tests then say whether ic still reads them.

const GOLDEN = join(packageRoot(import.meta.url), "golden");

const clear: StatePlan = {
    plan: STATE_PLAN_FORMAT,
    version: "1.400.0",
    engine: 84,
    digest: "c8cff51cab20a2b5",
    ok: true,
    downgrade: false,
    failures: [],
    steps: [
        { document: "conversations-db-schema", change: "upgrades the conversations database schema" },
        { document: `${STATE_DIR}/config/personas.json`, change: `moves it from ${STATE_DIR}/identities.json` },
    ],
    converts: [
        { document: `${STATE_DIR}/config/settings.json`, change: "converts personaRouting from its old values", detail: '"suggest" became true' },
    ],
    files: [`${STATE_DIR}/config/personas.json`],
};

const refused: StatePlan = {
    plan: STATE_PLAN_FORMAT,
    version: "1.400.0",
    engine: 84,
    digest: "c8cff51cab20a2b5",
    ok: false,
    downgrade: true,
    failures: [{ document: `${STATE_DIR}/config/automations.json`, detail: 'conversion "converts numbered kinds" failed: no such kind' }],
    steps: [],
    converts: [],
    files: [],
};

// The whole `/health` answer is the daemon's; ic reads only `state` out of it, so the golden carries just enough around it.
const health: { readonly ok: true; readonly state: StateStatus } = { ok: true, state: { journal: "open", engine: 84 } };

const goldens = [
    { file: "state-plan-clear.json", value: StatePlanSchema.parse(clear) },
    { file: "state-plan-refused.json", value: StatePlanSchema.parse(refused) },
    { file: "health-state.json", value: { ...health, state: StateStatusSchema.parse(health.state) } },
];

test.each(goldens)("golden/$file is the contract's example, as the host reads it", ({ file, value }) => {
    const path = join(GOLDEN, file);
    const expected = `${JSON.stringify(value, undefined, 2)}\n`;
    if (process.env["INTENTIC_WRITE_GOLDEN"] === "1") {
        writeFileSync(path, expected);
    }
    expect(readFileSync(path, "utf8")).toBe(expected);
});

test("a marker plan an older ic wrote, with only what it kept, still reads", () => {
    expect(StatePlanSchema.partial().extend({ ok: StatePlanSchema.shape.ok }).parse({ ok: true, downgrade: false, steps: [{ document: "a.json", change: "renames a to b" }] })).toEqual({
        ok: true,
        downgrade: false,
        steps: [{ document: "a.json", change: "renames a to b" }],
    });
});
