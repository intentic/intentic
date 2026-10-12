import { MODEL_ROLES, PRESET_SETUPS } from "./model-roles.js";

// The catalog draws the settings page directly, so its properties must hold of the table itself, not be remembered by
// whoever adds a row.

test("the page reads one-shots first, then whole sessions, in the table's own order", () => {
    const kinds = MODEL_ROLES.map((role) => role.kind);

    expect(kinds.indexOf(`run`)).toBe(kinds.lastIndexOf(`helper`) + 1);
});

test("every job is suggested a preset, and the cheap one is never suggested for a whole session", () => {
    expect(MODEL_ROLES.every((role) => PRESET_SETUPS.includes(role.setup))).toBe(true);
    expect(new Set<string>(MODEL_ROLES.filter((role) => role.kind === `run`).map((role) => role.setup)).has(`low`)).toBe(false);
});
