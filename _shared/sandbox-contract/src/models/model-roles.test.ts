import type { ModelPin } from "../schemas/agent.js";
import { followsDefault, MODEL_ROLES, rolePins } from "./model-roles.js";

// The catalog draws the settings page directly, so its properties must hold of the table itself, not be remembered by
// whoever adds a row; and the default list is a rule every reader shares, so it is pinned here once.

const opus: ModelPin = { provider: `claude`, model: `claude-opus-5-5` };
const haiku: ModelPin = { provider: `claude`, model: `claude-haiku-5-5` };

test("the page reads one-shots first, then whole sessions, in the table's own order", () => {
    const kinds = MODEL_ROLES.map((role) => role.kind);

    expect(kinds.indexOf(`run`)).toBe(kinds.lastIndexOf(`helper`) + 1);
});

test("a job with no list of its own runs on the default list", () => {
    const settings = { modelRoles: {}, modelDefault: [haiku] };

    expect(rolePins(settings, `commit-message`)).toEqual([haiku]);
    expect(rolePins(settings, `pipeline-fix`)).toEqual([haiku]);
    expect(followsDefault(settings, `commit-message`)).toBe(true);
});

test("a job's own list wins over the default, and an empty one is how a single job is switched off", () => {
    const settings = { modelRoles: { "pipeline-fix": [opus], "session-title": [] }, modelDefault: [haiku] };

    expect(rolePins(settings, `pipeline-fix`)).toEqual([opus]);
    expect(rolePins(settings, `session-title`)).toEqual([]);
    expect(followsDefault(settings, `session-title`)).toBe(false);
    expect(rolePins(settings, `commit-message`)).toEqual([haiku]);
});

test("with no default, a job with no list answers nothing, as it did before there was one", () => {
    expect(rolePins({ modelRoles: {}, modelDefault: [] }, `loop-verdict`)).toEqual([]);
});
