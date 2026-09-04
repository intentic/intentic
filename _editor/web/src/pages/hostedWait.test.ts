import type { BootReport } from "@intentic-app/api-contract";
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
        // The box's own words, verbatim: it is the only thing that knows.
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
        // A machine that looks perfectly healthy AND is being turned away every time it speaks: the shape a
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

    /* A MACHINE THAT NO LONGER EXISTS reads differently from one that is merely off, and the difference is the
     * whole reason `gone` is its own state: nothing is booting, nothing will check in, and the recovery costs
     * the disk. Said outright, immediately (no clock involved), and it outranks a machine still reporting a
     * healthy-looking state, which is what a stale poll would otherwise narrate. */
    it(`says outright when the machine is gone, and admits what starting over costs`, () => {
        const view = hostedWaitView(wait({ machine: `gone` }));
        expect(view.failure?.problem).toContain(`isn't there any more`);
        expect(view.failure?.remedy).toContain(`gone with it`);
        // `reboot`, not `remake`: the platform's restart route replaces a machine that no longer exists, while
        // `remake` hands the sandbox back first, which it refuses to do for anything that has ever connected.
        expect(view.failure?.action).toBe(`reboot`);
        // No amount of waiting is involved, and a boot report from before the machine died cannot outvote it.
        expect(hostedWaitView(wait({ machine: `gone`, waitedMs: 0, announced: true, boot: boot(`reachable`) })).failure?.problem).toContain(
            `isn't there any more`,
        );
    });

    it(`says so when a running machine has gone silent for long enough`, () => {
        const silent = wait({ machine: `started`, waitedMs: 4 * 60_000 });
        expect(hostedWaitView(silent).failure?.problem).toContain(`hasn't checked in`);
        // …but not while it is still plausibly booting.
        expect(hostedWaitView({ ...silent, waitedMs: 60_000 }).failure).toBeUndefined();
        // …and never against a machine that has not finished starting.
        expect(hostedWaitView({ ...silent, machine: `starting` }).failure).toBeUndefined();
    });

    /* THE PROMISE MATCHES THE MACHINE'S ORIGIN. A pool machine really is seconds; a built-to-order one spends
     * its first boot pulling the image, and "under a minute" over that pull is the lie that made healthy first
     * boots read as stuck. Unknown origin (an older row) must keep the old promise exactly. */
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

    /* THE CLOCK MAY COUNT, NEVER DIAGNOSE: minutes on the note prove the page is counting rather than frozen,
     * and once an origin's own promise is spent the note switches to patience: still no failure invented. */
    it(`counts the minutes and switches to reassurance once the promise is spent`, () => {
        const midPull = hostedWaitView(wait({ warm: false, machine: `created`, waitedMs: 2 * 60_000 }));
        expect(midPull.failure).toBeUndefined();
        expect(midPull.note).toContain(`2 min in`);
        expect(midPull.note).toContain(`3 to 5 minutes`);
        // Past its own estimate the estimate would be a lie in the other direction: patience instead.
        const past = hostedWaitView(wait({ warm: false, machine: `created`, waitedMs: 6 * 60_000 }));
        expect(past.failure).toBeUndefined();
        expect(past.note).toContain(`still going`);
        // A warm machine's promise is spent far sooner.
        expect(hostedWaitView(wait({ warm: true, machine: `starting`, waitedMs: 2 * 60_000 })).note).toContain(`longer than usual`);
        expect(hostedWaitView(wait({ warm: true, machine: `starting`, waitedMs: 30_000 })).note).toContain(`under a minute`);
    });

    it(`offers a way out of a machine that never comes up, without calling the pull broken early`, () => {
        // Ten minutes in `created` is not a pull any more: SILENT_MS deliberately never fires on
        // `starting`/`created`, so without this ceiling the note would reassure forever with nothing to press.
        const view = hostedWaitView(wait({ warm: false, machine: `created`, waitedMs: 11 * 60_000 }));
        expect(view.failure?.problem).toContain(`far longer`);
        expect(view.failure?.action).toBe(`reboot`);
        // …but a pull inside its worst honest case stays narration, however impatient the reader.
        expect(hostedWaitView(wait({ warm: false, machine: `created`, waitedMs: 9 * 60_000 })).failure).toBeUndefined();
    });

    /* THE HANDOVER GATE. `reachable` is the only thing the wizard is allowed to hold the door on, and
     * `undefined` (a sandbox that has said nothing, which is every sandbox older than this reporting) must
     * read as "don't hold", or this would wedge the flows it exists to unwedge. */
    it(`reports reachability as a verdict, never as an assumption`, () => {
        expect(hostedWaitView(wait()).reachable).toBeUndefined();
        expect(hostedWaitView(wait({ announced: true })).reachable).toBeUndefined();
        expect(hostedWaitView(wait({ boot: boot(`checking`) })).reachable).toBe(false);
        expect(hostedWaitView(wait({ boot: boot(`unreachable`) })).reachable).toBe(false);
        expect(hostedWaitView(wait({ boot: boot(`reachable`) })).reachable).toBe(true);
    });
});

/* ONE WAIT, NOT TWO. The daemon announces before its boot chain runs, so the handover used to land the reader on
 * the workspace's own warm-up card straight after this one. With the chain riding the report, this card holds
 * on it, names the running step, and lets go only once the daemon says it is converged. A daemon that reports
 * no chain (an older image) behaves exactly as before. */
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
