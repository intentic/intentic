// Pins what a pick in "Where heavy work runs" writes (settings `offload`) and how a runner is offered and named.
import type { RunnerSummary } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { HERE, kindTitle, runnerName, sessionsOptions, targetOptions, unavailableRunner, withCommandTarget, withSessions } from "./offloadRows";

const omen: RunnerSummary = { id: `runner-omen`, label: `Gaming PC`, host: `omen`, online: true, parity: `current` };
const asleep: RunnerSummary = { id: `runner-rog`, host: `rog`, online: false, parity: `current` };

describe(`where heavy work runs`, () => {
    // Not by the computer it sits on, as until 2026-11-21: two runners on one computer read the same that way.
    test(`a runner is named by the name it was given, else by its id`, () => {
        expect(runnerName(omen)).toBe(`Gaming PC`);
        expect(runnerName({ id: `runner-x` })).toBe(`runner-x`);
    });

    test(`this sandbox comes first, then any machine with room, then every runner, an offline one still offered`, () => {
        expect(targetOptions([omen, asleep]).map(({ value, label }) => [value, label])).toEqual([
            [HERE, `This sandbox`],
            [`auto`, `Any machine with room`],
            [`runner-omen`, `Gaming PC`],
            [`runner-rog`, `runner-rog`],
        ]);
        // The computer each is on rides beside whether it is there now.
        expect(targetOptions([omen, asleep]).slice(2).map(({ description }) => description)).toEqual([`omen · Connected`, `rog · Offline now: work sent here runs in this sandbox until it's back`]);
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
        expect(unavailableRunner(`runner-rog`, [asleep])).toBe(`runner-rog is offline, so this runs here until it's back.`);
        expect(unavailableRunner(`runner-gone`, [omen])).toBe(`The runner "runner-gone" is no longer set up, so this runs here.`);
    });

    // Which runner is decided as each command starts, so only a fleet with none at all is worth a word.
    test(`any machine with room says nothing while there is a runner, and that the work runs here while there is none`, () => {
        expect(unavailableRunner(`auto`, [asleep])).toBeUndefined();
        expect(unavailableRunner(`auto`, [])).toBe(`Runs here until a runner is set up on one of your machines.`);
    });
});
