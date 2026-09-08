import type { BootReport } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { hostedWaitView, type HostedWaitInput } from "./hostedWait";

// A wait with nothing known yet: every case below is this plus the one fact it is about.
const wait = (over: Partial<HostedWaitInput> = {}): HostedWaitInput => ({
    machine: undefined,
    boot: null,
    refusal: null,
    announced: false,
    warm: undefined,
    waitedMs: 0,
    ...over,
});

const boot = (reach: BootReport[`reach`], detail?: string): BootReport => ({ reach, at: `2026-08-13T10:00:00.000Z`, ...(detail ? { detail } : {}) });

// Which step the list is sitting on: the card's whole progress claim in one value.
const active = (input: HostedWaitInput): string | undefined => hostedWaitView(input).steps.find((step) => step.state === `active`)?.key;

describe(`hostedWaitView`, () => {
    it(`walks the steps as each source reports, without a clock`, () => {
        expect(active(wait())).toBe(`machine`);
        expect(active(wait({ machine: `starting` }))).toBe(`machine`);
        expect(active(wait({ machine: `started` }))).toBe(`booting`);
        expect(active(wait({ machine: `started`, boot: boot(`checking`) }))).toBe(`connecting`);
        expect(active(wait({ machine: `started`, announced: true }))).toBe(`connecting`);
        expect(active(wait({ machine: `started`, announced: true, boot: boot(`reachable`) }))).toBe(`ready`);
    });

    it(`never calls a boot broken for taking a moment`, () => {
        const early = wait({ machine: `started`, announced: true, boot: boot(`unreachable`, `not yet`), waitedMs: 20_000 });
        expect(hostedWaitView(early).failure).toBeUndefined();
        expect(active(early)).toBe(`connecting`);
    });

    it(`names a tunnel that never came up, once the sandbox has stopped trying`, () => {
        const stuck = wait({
            machine: `started`,
            announced: true,
            boot: boot(`unreachable`, `sandbox-abc.sbx.test could not be reached from inside the sandbox.`),
            waitedMs: 6 * 60_000,
        });
        const view = hostedWaitView(stuck);
        expect(view.failure?.problem).toContain(`could not be reached`);
        expect(view.failure?.action).toBe(`reboot`);
    });

    it(`stops believing a sandbox that said it was checking and never came back`, () => {
        const view = hostedWaitView(wait({ machine: `started`, announced: true, boot: boot(`checking`), waitedMs: 6 * 60_000 }));
        expect(view.failure?.problem).toContain(`can't be reached`);
        expect(view.failure?.action).toBe(`reboot`);
    });

    it(`names a refused check-in with both halves, and outranks every other reading`, () => {
        // Healthy machine plus a live refusal: the shape a half-migrated sandbox takes.
        const view = hostedWaitView(
            wait({
                machine: `started`,
                boot: boot(`reachable`),
                refusal: { announced: `old.example.dev`, expected: `sandbox-abc.sbx.test` },
            }),
        );
        expect(view.failure?.problem).toContain(`old.example.dev`);
        expect(view.failure?.problem).toContain(`sandbox-abc.sbx.test`);
        expect(view.failure?.action).toBe(`remake`);
    });

    it(`names a machine that isn't running`, () => {
        expect(hostedWaitView(wait({ machine: `failed` })).failure?.problem).toContain(`isn't running`);
        expect(hostedWaitView(wait({ machine: `stopped` })).failure?.action).toBe(`reboot`);
    });

    it(`says outright when the machine is gone, and admits what starting over costs`, () => {
        const view = hostedWaitView(wait({ machine: `gone` }));
        expect(view.failure?.problem).toContain(`isn't there any more`);
        expect(view.failure?.remedy).toContain(`gone with it`);
        expect(view.failure?.action).toBe(`reboot`);
        expect(hostedWaitView(wait({ machine: `gone`, waitedMs: 0, announced: true, boot: boot(`reachable`) })).failure?.problem).toContain(
            `isn't there any more`,
        );
    });

    it(`says so when a running machine has gone silent for long enough`, () => {
        const silent = wait({ machine: `started`, waitedMs: 4 * 60_000 });
        expect(hostedWaitView(silent).failure?.problem).toContain(`hasn't checked in`);
        expect(hostedWaitView({ ...silent, waitedMs: 60_000 }).failure).toBeUndefined();
        expect(hostedWaitView({ ...silent, machine: `starting` }).failure).toBeUndefined();
    });

    it(`promises minutes for a built-to-order machine and seconds for a warm one`, () => {
        expect(hostedWaitView(wait({ warm: false })).note).toContain(`3 to 5 minutes`);
        expect(hostedWaitView(wait({ warm: true })).note).toContain(`under a minute`);
        expect(hostedWaitView(wait()).note).toContain(`under a minute`);
    });

    it(`names the download on a built-to-order machine's first step, and only there`, () => {
        const label = (input: HostedWaitInput): string | undefined => hostedWaitView(input).steps.find((step) => step.key === `machine`)?.label;
        expect(label(wait({ warm: false }))).toContain(`downloading your sandbox`);
        expect(label(wait({ warm: true }))).toBe(`Starting the machine`);
        expect(label(wait())).toBe(`Starting the machine`);
    });

    it(`counts the minutes and switches to reassurance once the promise is spent`, () => {
        const midPull = hostedWaitView(wait({ warm: false, machine: `created`, waitedMs: 2 * 60_000 }));
        expect(midPull.failure).toBeUndefined();
        expect(midPull.note).toContain(`2 min in`);
        expect(midPull.note).toContain(`3 to 5 minutes`);
        const past = hostedWaitView(wait({ warm: false, machine: `created`, waitedMs: 6 * 60_000 }));
        expect(past.failure).toBeUndefined();
        expect(past.note).toContain(`still going`);
        expect(hostedWaitView(wait({ warm: true, machine: `starting`, waitedMs: 2 * 60_000 })).note).toContain(`longer than usual`);
        expect(hostedWaitView(wait({ warm: true, machine: `starting`, waitedMs: 30_000 })).note).toContain(`under a minute`);
    });

    it(`offers a way out of a machine that never comes up, without calling the pull broken early`, () => {
        // 11 minutes: past double SILENT_MS's window, so `created` no longer reads as an ordinary pull.
        const view = hostedWaitView(wait({ warm: false, machine: `created`, waitedMs: 11 * 60_000 }));
        expect(view.failure?.problem).toContain(`far longer`);
        expect(view.failure?.action).toBe(`reboot`);
        // 9 minutes still fits the worst-case pull window, so no failure yet.
        expect(hostedWaitView(wait({ warm: false, machine: `created`, waitedMs: 9 * 60_000 })).failure).toBeUndefined();
    });

    it(`reports reachability as a verdict, never as an assumption`, () => {
        expect(hostedWaitView(wait()).reachable).toBeUndefined();
        expect(hostedWaitView(wait({ announced: true })).reachable).toBeUndefined();
        expect(hostedWaitView(wait({ boot: boot(`checking`) })).reachable).toBe(false);
        expect(hostedWaitView(wait({ boot: boot(`unreachable`) })).reachable).toBe(false);
        expect(hostedWaitView(wait({ boot: boot(`reachable`) })).reachable).toBe(true);
    });
});

// This card holds on a running boot chain, naming the step, and lets go once the daemon reports convergence.
// A report with no chain (older image) behaves as before.
describe(`the boot chain on the card`, () => {
    const chained = (ready: boolean, step?: string): BootReport => ({
        ...boot(`reachable`),
        boot: { ready, done: ready ? 15 : 6, total: 15, ...(step === undefined ? {} : { step }) },
    });

    it(`holds on a reachable daemon whose chain is still running, and names the step`, () => {
        const view = hostedWaitView(wait({ machine: `started`, announced: true, boot: chained(false, `Putting your starter site in place`) }));
        expect(view.booting).toBe(true);
        expect(view.steps.find((step) => step.state === `active`)?.key).toBe(`booting`);
        expect(view.steps.find((step) => step.key === `booting`)?.label).toBe(`Starting your sandbox: Putting your starter site in place`);
    });

    it(`lets go once the chain has converged`, () => {
        const view = hostedWaitView(wait({ machine: `started`, announced: true, boot: chained(true) }));
        expect(view.booting).toBe(false);
        expect(view.steps.find((step) => step.state === `active`)?.key).toBe(`ready`);
        expect(view.steps.find((step) => step.key === `booting`)?.label).toBe(`Starting your sandbox`);
    });

    it(`reads a report with no chain as the hand-over-on-announce it always was`, () => {
        expect(hostedWaitView(wait({ machine: `started`, announced: true, boot: boot(`reachable`) })).booting).toBe(false);
        expect(hostedWaitView(wait()).booting).toBe(false);
    });
});
