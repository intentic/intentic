import type { SessionModes } from "@intentic/acp-events/modes";
import { hostModeFor } from "../turn.js";

// Which of an agent's own modes a turn on this computer is put in. Nothing here is sandboxed, so the answer is never
// the agent's run-without-asking mode, whatever the turn asks for and whatever mode the session was left in.

const modes = (current: string, ...ids: string[]): SessionModes => ({ current, home: current, available: ids.map((id) => ({ id, name: id })) });

describe(`hostModeFor`, () => {
    const claude = modes(`auto`, `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`);

    it(`puts a turn that names no posture, or the asking one, in the agent's asking mode`, () => {
        expect(hostModeFor(claude, undefined)).toBe(`default`);
        expect(hostModeFor(claude, `default`)).toBe(`default`);
    });

    it(`puts a planning turn in the agent's own plan mode`, () => {
        expect(hostModeFor(claude, `plan`)).toBe(`plan`);
    });

    it(`gives a turn that asks to run without asking no more than accepted edits`, () => {
        expect(hostModeFor(claude, `bypassPermissions`)).toBe(`acceptEdits`);
    });

    it(`falls back to asking where the agent has no such mode, and to its own default where it names none of them`, () => {
        const devin = modes(`smart`, `ask`, `smart`, `bypass`);
        expect(hostModeFor(devin, `bypassPermissions`)).toBe(`ask`);
        expect(hostModeFor(devin, `plan`)).toBe(`ask`);
        const plain = modes(`code`, `code`, `architect`);
        expect(hostModeFor(plain, `bypassPermissions`)).toBe(`code`);
        expect(hostModeFor(plain, undefined)).toBe(`code`);
    });

    it(`reads a mode by its name as well as its id`, () => {
        const named: SessionModes = { current: `m2`, home: `m2`, available: [{ id: `m1`, name: `Manual` }, { id: `m2`, name: `Auto` }, { id: `m3`, name: `Accept Edits` }] };
        expect(hostModeFor(named, `default`)).toBe(`m1`);
        expect(hostModeFor(named, `bypassPermissions`)).toBe(`m3`);
    });
});
