import type { Requirement, SetupArgs, SetupReport } from "../../desktop";
import { setupProcessId, setupProcessOf, type SetupFacts } from "./setupProcess";

// A sandbox's setup on this computer as the process both faces draw (2026-10-26): the same run, with what the reader
// can do about it from wherever they are, never a reason to move them.

const args: SetupArgs = { code: `c`, sandboxId: `sbx_7`, name: `shop` };
const facts = (report: SetupReport | undefined, more: Partial<SetupFacts> = {}): SetupFacts => ({
    args,
    report,
    requirements: [],
    requirementsShown: false,
    expired: false,
    failure: undefined,
    ...more,
});
const wsl: Requirement = { id: `wsl`, title: `Windows Subsystem for Linux`, problem: `Not installed`, remedy: `Install it`, action: `fixElevated` };

describe(`a setup on this computer, as a process`, () => {
    it(`is the sandbox it makes, running with its Stop`, () => {
        const process = setupProcessOf(facts({ state: `running`, percent: 40, position: `Step 4 of 10`, step: `pulling-image` }));
        expect(process).toMatchObject({ id: `sandbox-setup:sbx_7`, kind: `sandbox-setup`, state: `running`, subject: `shop`, sandboxId: `sbx_7`, percent: 40, position: `Step 4 of 10`, actions: [`stop`] });
        expect(setupProcessId(undefined)).toBe(`sandbox-setup:here`);
    });

    it(`asks what its card asks, the requirements as needs, a machine of ours offered beside`, () => {
        const process = setupProcessOf(facts({ state: `waiting`, percent: 10, waitingFor: `consent` }, { requirements: [wsl], requirementsShown: true }));
        expect(process?.waitingFor).toBe(`consent`);
        expect(process?.actions).toEqual([`consent`, `use-hosted`, `dismiss`]);
        expect(process?.needs).toEqual([{ id: `wsl`, label: `Windows Subsystem for Linux`, detail: `Not installed` }]);
        expect(setupProcessOf(facts({ state: `waiting`, percent: 10, waitingFor: `restart` }))?.actions?.[0]).toBe(`restart-now`);
        expect(setupProcessOf(facts({ state: `waiting`, percent: 10, waitingFor: `pcSetup` }))?.actions).toEqual([`use-hosted`, `dismiss`]);
    });

    it(`says why it failed, and a code that ran out is answered with a fresh one`, () => {
        expect(setupProcessOf(facts({ state: `failed`, percent: 50 }, { failure: `Docker would not start` }))).toMatchObject({ failure: `Docker would not start`, actions: [`retry`, `use-hosted`, `dismiss`] });
        expect(setupProcessOf(facts({ state: `failed`, percent: 50 }, { expired: true }))?.actions?.[0]).toBe(`fresh-code`);
    });

    it(`is done with its Open, and nothing once its card is put away`, () => {
        expect(setupProcessOf(facts({ state: `done`, percent: 100 }))?.actions).toEqual([`open`, `dismiss`]);
        expect(setupProcessOf(facts({ state: `closed`, percent: 0 }))).toBeUndefined();
        expect(setupProcessOf(facts(undefined))).toBeUndefined();
    });
});
