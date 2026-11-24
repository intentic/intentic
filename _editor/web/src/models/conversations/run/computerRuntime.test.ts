import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { computerCapabilities } from "./computerRuntime";

// What a turn on this computer can do, read off the sandbox's own table and narrowed to what the sidecar serves.
describe(`a harness's capabilities on this computer`, () => {
    const sandbox = capabilitiesOf(`claude`, `native`);
    const here = computerCapabilities(sandbox);

    it(`takes a message said mid-turn as the next turn, never into the one running`, () => {
        expect(here.steering).toBe(false);
    });

    it(`offers the three modes, with no fast speed and no warm session`, () => {
        expect([here.permissions, here.fastMode, here.warm]).toEqual([`modes`, false, false]);
    });

    it(`leaves the rest as the harness has it`, () => {
        expect(here.effort).toBe(sandbox.effort);
        expect(here.runtime).toBe(sandbox.runtime);
    });
});
