import { modeTableFor } from "./catalog";

// HOW MUCH AN AGENT DOES BEFORE ASKING, worded for where it runs. In a sandbox "Auto" is safe to offer because the
// sandbox contains it; on this computer nothing does, so the same three modes read as what they mean there, and none of
// them promises a card for every action: the reader's own harness settings still allow what they allow.
describe(`the modes of a chat on this computer`, () => {
    const here = modeTableFor(true);
    const sandbox = modeTableFor(false);

    it(`names the default "Ask first" and says whose settings still apply`, () => {
        expect(here.default.label).toBe(`Ask first`);
        expect(here.default.description).toBe(`The agent asks before it acts, except for what its own settings on this computer already allow.`);
    });

    it(`serves the unattended mode as accepting edits, never as running everything`, () => {
        expect(here.bypassPermissions.label).toBe(`Accept edits`);
        expect(here.bypassPermissions.description).toBe(`File edits without asking; commands still ask, unless its own settings allow them.`);
        expect(here.bypassPermissions.label).not.toBe(sandbox.bypassPermissions.label);
    });

    it(`keeps Plan a plan`, () => {
        expect(here.plan.label).toBe(sandbox.plan.label);
        expect(here.plan.description).toBe(`Reads and proposes a plan. Changes nothing until you approve.`);
    });
});
