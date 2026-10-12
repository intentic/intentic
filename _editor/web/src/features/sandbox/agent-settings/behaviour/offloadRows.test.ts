// Pins what a pick in "Where heavy work runs" writes (settings `offload`) and how a runner is offered and named.
import type { RunnerSummary } from "@intentic/sandbox-contract";
import { HERE, kindTitle, runnerName, sessionsOptions, targetOptions, unavailableRunner, withCommandTarget, withSessions } from "./offloadRows";

const omen: RunnerSummary = { id: `runner-omen`, host: `omen`, online: true, parity: `current` };
const asleep: RunnerSummary = { id: `runner-rog`, host: `rog`, online: false, parity: `current` };

describe(`where heavy work runs`, () => {
    test(`a runner is named by the machine it sits on, one started by hand by its id`, () => {
        expect(runnerName(omen)).toBe(`omen`);
        expect(runnerName({ id: `runner-x` })).toBe(`runner-x`);
    });

    test(`this sandbox comes first, then every runner, an offline one still offered`, () => {
        expect(targetOptions([omen, asleep]).map(({ value, label }) => [value, label])).toEqual([
            [HERE, `This sandbox`],
            [`runner-omen`, `omen`],
            [`runner-rog`, `rog`],
        ]);
    });

    test(`picking a runner sets that kind alone, and picking this sandbox removes it`, () => {
        const sent = withCommandTarget({ commands: { vitest: `runner-rog` }, sessions: `auto` }, `bun-test`, `runner-omen`);
        expect(sent).toEqual({ commands: { vitest: `runner-rog`, "bun-test": `runner-omen` }, sessions: `auto` });
        expect(withCommandTarget(sent, `vitest`, HERE)).toEqual({ commands: { "bun-test": `runner-omen` }, sessions: `auto` });
    });

    test(`a kind the shipped rules name reads in words, one the owner added reads as its id`, () => {
        expect(kindTitle({ id: `typechecker`, pattern: `tsc` })).toBe(`Typechecks`);
        expect(kindTitle({ id: `my-build`, pattern: `make` })).toBe(`my-build`);
    });

    // New chats: suggesting first, since it is the default and moves nothing by itself.
    test(`new chats offer suggest, then auto, then off, and a pick leaves every command's target alone`, () => {
        expect(sessionsOptions().map(({ value, label }) => [value, label])).toEqual([
            [`suggest`, `Suggest`],
            [`auto`, `Automatic`],
            [`off`, `Off`],
        ]);
        expect(withSessions({ commands: { vitest: `runner-rog` }, sessions: `suggest` }, `auto`)).toEqual({
            commands: { vitest: `runner-rog` },
            sessions: `auto`,
        });
    });

    test(`a pick naming an offline or vanished runner says the work runs here meanwhile`, () => {
        expect(unavailableRunner(undefined, [omen])).toBeUndefined();
        expect(unavailableRunner(`runner-omen`, [omen])).toBeUndefined();
        expect(unavailableRunner(`runner-rog`, [asleep])).toBe(`rog is offline, so this runs here until it's back.`);
        expect(unavailableRunner(`runner-gone`, [omen])).toBe(`The runner "runner-gone" is no longer set up, so this runs here.`);
    });
});
