import type { BootReport } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { hostedWaitView, type HostedWaitInput } from "./hostedWait";

// A wait with nothing known yet — every case below is this plus the one fact it is about.
const wait = (over: Partial<HostedWaitInput> = {}): HostedWaitInput => ({
    machine: undefined,
    boot: null,
    refusal: null,
    announced: false,
    waitedMs: 0,
    ...over,
});

const boot = (reach: BootReport[`reach`], detail?: string): BootReport => ({ reach, at: `2026-08-13T10:00:00.000Z`, ...(detail ? { detail } : {}) });

// Which step the list is sitting on — the card's whole progress claim in one value.
const active = (input: HostedWaitInput): string | undefined => hostedWaitView(input).steps.find((step) => step.state === `active`)?.key;

describe(`hostedWaitView`, () => {
    it(`walks the steps as each source reports, without a clock`, () => {
        // Nothing known: the machine is being made. A wait that knows nothing says the least, not the most.
        expect(active(wait())).toBe(`machine`);
        expect(active(wait({ machine: `starting` }))).toBe(`machine`);
        // The machine is up, so whatever happens next happens inside it.
        expect(active(wait({ machine: `started` }))).toBe(`booting`);
        // The daemon exists and is testing its own address.
        expect(active(wait({ machine: `started`, boot: boot(`checking`) }))).toBe(`connecting`);
        // …or has checked in, which says the same thing from the other side.
        expect(active(wait({ machine: `started`, announced: true }))).toBe(`connecting`);
        expect(active(wait({ machine: `started`, announced: true, boot: boot(`reachable`) }))).toBe(`ready`);
    });

    it(`never calls a boot broken for taking a moment`, () => {
        // The single most important non-failure: a tunnel binding a few seconds after the daemon comes up is
        // the ORDINARY case, and the old card's only other option was to keep saying nothing.
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
        // The box's own words, verbatim — it is the only thing that knows.
        expect(view.failure?.problem).toContain(`could not be reached`);
        // Its files are fine; it is the boot's networking half that needs running again.
        expect(view.failure?.action).toBe(`reboot`);
    });

    it(`stops believing a sandbox that said it was checking and never came back`, () => {
        // A daemon that died mid-probe. Reading this as "still working" forever would rebuild the silent wait
        // this whole thing replaces, one state to the left.
        const view = hostedWaitView(wait({ machine: `started`, announced: true, boot: boot(`checking`), waitedMs: 6 * 60_000 }));
        expect(view.failure?.problem).toContain(`can't be reached`);
        expect(view.failure?.action).toBe(`reboot`);
    });

    it(`names a refused check-in with both halves, and outranks every other reading`, () => {
        // A machine that looks perfectly healthy AND is being turned away every time it speaks — the shape a
        // half-migrated sandbox takes, and the one where waiting can never help.
        const view = hostedWaitView(
            wait({
                machine: `started`,
                boot: boot(`reachable`),
                refusal: { announced: `old.example.dev`, expected: `sandbox-abc.sbx.test` },
            }),
        );
        expect(view.failure?.problem).toContain(`old.example.dev`);
        expect(view.failure?.problem).toContain(`sandbox-abc.sbx.test`);
        // The wrong address is built into this machine, so booting it again would reproduce it exactly.
        expect(view.failure?.action).toBe(`remake`);
    });

    it(`names a machine that isn't running`, () => {
        expect(hostedWaitView(wait({ machine: `failed` })).failure?.problem).toContain(`isn't running`);
        expect(hostedWaitView(wait({ machine: `stopped` })).failure?.action).toBe(`reboot`);
    });

    it(`says so when a running machine has gone silent for long enough`, () => {
        const silent = wait({ machine: `started`, waitedMs: 4 * 60_000 });
        expect(hostedWaitView(silent).failure?.problem).toContain(`hasn't checked in`);
        // …but not while it is still plausibly booting.
        expect(hostedWaitView({ ...silent, waitedMs: 60_000 }).failure).toBeUndefined();
        // …and never against a machine that has not finished starting.
        expect(hostedWaitView({ ...silent, machine: `starting` }).failure).toBeUndefined();
    });

    /* THE HANDOVER GATE. `reachable` is the only thing the wizard is allowed to hold the door on, and
     * `undefined` — a sandbox that has said nothing, which is every sandbox older than this reporting — must
     * read as "don't hold", or this would wedge the flows it exists to unwedge. */
    it(`reports reachability as a verdict, never as an assumption`, () => {
        expect(hostedWaitView(wait()).reachable).toBeUndefined();
        expect(hostedWaitView(wait({ announced: true })).reachable).toBeUndefined();
        expect(hostedWaitView(wait({ boot: boot(`checking`) })).reachable).toBe(false);
        expect(hostedWaitView(wait({ boot: boot(`unreachable`) })).reachable).toBe(false);
        expect(hostedWaitView(wait({ boot: boot(`reachable`) })).reachable).toBe(true);
    });
});
