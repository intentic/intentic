import { expect, test } from "vitest";
import { type DeviceSandboxResources, resourcesSummary } from "@intentic/ui/device";
import { askFrom, capFromField, cpuBounds, formFrom, formProblems, gpuDropped, locksOf, memoryBounds } from "@intentic/ui/sandbox-resources";

/* THE RESOURCES FORM'S ARITHMETIC, pinned from this side for the reason SandboxDevices.test.ts pins the verb
 * vocabulary: the kit has no test runner, this package is the one that renders the form, and the form's whole
 * contract is what it starts from, what it refuses, and what leaves when Apply is pressed. Through the deep path,
 * not the barrel: adding two GiB should not have to boot the component graph. */

const GIB = 1024 ** 3;

// A container as the machine reads it: a 12 GiB cap, four cores, privileged because the approved environment
// (the Docker capability) demands it, no GPU anywhere.
const share = (overrides: Partial<DeviceSandboxResources> = {}): DeviceSandboxResources => ({
    memoryBytes: 12 * GIB,
    cpus: 4,
    privileged: true,
    gpu: false,
    hostRuntime: [],
    overlayRuntime: [`--privileged`],
    ...overrides,
});

/* THE RAILS MIRROR THE RUN CONTRACT: whole GiB from a 4 GiB floor to the engine minus the 3 GiB the host keeps,
 * whole cores from one to the engine's count. A machine too small to grant the floor still offers the floor (the
 * contract gives it the floor anyway), and a machine that could not be measured leaves the ceiling open rather
 * than inventing one. */
test(`bounds a cap by the engine, minus what the host keeps`, () => {
    expect(memoryBounds({ memoryBytes: 20 * GIB, cpus: 12 })).toEqual({ min: 4, max: 17 });
    expect(memoryBounds({ memoryBytes: 6 * GIB, cpus: 2 })).toEqual({ min: 4, max: 4 });
    expect(memoryBounds(undefined)).toEqual({ min: 4 });
    expect(cpuBounds({ memoryBytes: 20 * GIB, cpus: 12 })).toEqual({ min: 1, max: 12 });
    expect(cpuBounds(undefined)).toEqual({ min: 1 });
});

/* WHERE THE FORM STARTS: the container as it runs. Caps round down to whole units, the contract's own direction;
 * an absent cap is the default (empty field). The switches hold the ASK, so a privilege docker granted and one
 * somebody asked for both read as on. */
test(`opens on the container's own share`, () => {
    expect(formFrom(share())).toEqual({ memoryGib: 12, cpus: 4, privileged: true, gpu: false });
    // A cap set by hand at 12.5 GiB is offered as 12: the field is whole GiB, and rounding up would offer bytes
    // the machine does not grant.
    expect(formFrom(share({ memoryBytes: 12.5 * GIB, cpus: 1.5 })).memoryGib).toBe(12);
    expect(formFrom(share({ cpus: 1.5 })).cpus).toBe(1);
    // Unbounded is the default, not zero: the hosted shape's container carries no cap at all.
    expect(formFrom(share({ memoryBytes: undefined, cpus: undefined }))).toMatchObject({ memoryGib: null, cpus: null });
});

/* THE ONE SWITCH WHOSE ASK AND ANSWER CAN DISAGREE. A host without the NVIDIA runtime drops `--gpus`, so the
 * container reports no GPU while the owner's list still asks for one. The switch stays where the owner left it
 * and the row says what became of the ask; drawing it off and letting Apply re-request it would re-state a wish
 * nobody withdrew. */
test(`keeps a dropped GPU asked for, and says so`, () => {
    const dropped = share({ gpu: false, hostRuntime: [`--gpus=all`] });
    expect(formFrom(dropped).gpu).toBe(true);
    expect(gpuDropped(dropped)).toBe(true);
    // Granted, or never asked: nothing to say.
    expect(gpuDropped(share({ gpu: true, hostRuntime: [`--gpus=all`] }))).toBe(false);
    expect(gpuDropped(share())).toBe(false);
});

/* WHICH SWITCHES ARE NOT THE OWNER'S: a directive the approved environment demands rides on the container
 * whatever the owner's own list says, so the form draws it locked with the reason, rather than live and silently
 * ignored on Apply. The owner's own ask is theirs to withdraw and locks nothing. */
test(`locks a privilege the approved environment demands, and only that one`, () => {
    expect(locksOf(share())).toEqual({ privileged: expect.stringContaining(`approved environment`) });
    expect(locksOf(share({ overlayRuntime: [`--privileged`, `--gpus=all`] }))).toEqual({
        privileged: expect.any(String),
        gpu: expect.any(String),
    });
    expect(locksOf(share({ privileged: true, hostRuntime: [`--privileged`], overlayRuntime: [] }))).toEqual({});
});

/* WHAT LEAVES IS A DIFF, in the contract's own ask shape: absent means "leave it", `null` on a cap means "back to
 * the default". Nothing changed is nothing to send, and the dialog's Apply is disabled on it, so the machine's
 * refusal of an empty reshape is unreachable from the form. */
test(`sends only what changed, and nothing when nothing did`, () => {
    const initial = formFrom(share());
    expect(askFrom(initial, { ...initial })).toBeUndefined();
    expect(askFrom(initial, { ...initial, memoryGib: 16 })).toEqual({ memoryGib: 16 });
    // Clearing the field is the ask for the default, and it IS a change from a cap that was set.
    expect(askFrom(initial, { ...initial, memoryGib: null })).toEqual({ memoryGib: null });
    expect(askFrom(initial, { ...initial, cpus: null, gpu: true })).toEqual({ cpus: null, gpu: true });
    // A field that was already at the default and stays there says nothing.
    const unbounded = formFrom(share({ cpus: undefined }));
    expect(askFrom(unbounded, { ...unbounded, memoryGib: 8 })).toEqual({ memoryGib: 8 });
});

/* WHY A FORM CANNOT BE APPLIED, said under the field it is about: a fraction, or a cap outside the rails. An
 * empty field is never a problem, it is the default; an unmeasured engine has no ceiling to exceed. */
test(`names the field that is outside the rails`, () => {
    const engine = { memoryBytes: 20 * GIB, cpus: 12 };
    const fine = formFrom(share());
    expect(formProblems(fine, engine)).toEqual({});
    expect(formProblems({ ...fine, memoryGib: 2 }, engine)).toEqual({ memory: expect.stringContaining(`At least 4 GiB`) });
    expect(formProblems({ ...fine, memoryGib: 18 }, engine)).toEqual({ memory: expect.stringContaining(`At most 17 GiB`) });
    expect(formProblems({ ...fine, memoryGib: 8.5 }, engine)).toEqual({ memory: `Whole GiB only.` });
    expect(formProblems({ ...fine, cpus: 0 }, engine)).toEqual({ cpus: expect.stringContaining(`At least 1 CPUs`) });
    expect(formProblems({ ...fine, cpus: 16 }, engine)).toEqual({ cpus: expect.stringContaining(`At most 12 CPUs`) });
    // Both at once are both said, each under its own field.
    expect(Object.keys(formProblems({ ...fine, memoryGib: 1, cpus: 99 }, engine))).toEqual([`memory`, `cpus`]);
    // No engine, no ceiling: the contract clamps whatever arrives, and the form does not guess at a number.
    expect(formProblems({ ...fine, memoryGib: 999, cpus: 999 }, undefined)).toEqual({});
    expect(formProblems({ ...fine, memoryGib: null, cpus: null }, engine)).toEqual({});
});

/* A NUMBER FIELD READ BACK: empty is the default, a number is a number (including the ones the browser's own
 * min/max merely advise against, which formProblems judges), and not-a-number mid-edit changes nothing. */
test(`reads an empty field as the default and leaves a half-typed one alone`, () => {
    expect(capFromField(``)).toBeNull();
    expect(capFromField(`  `)).toBeNull();
    expect(capFromField(`16`)).toBe(16);
    expect(capFromField(`8.5`)).toBe(8.5);
    expect(capFromField(`-1`)).toBe(-1);
    expect(capFromField(`1e`)).toBeUndefined();
});

/* THE ROW'S OWN LINE, from the same share: only what was set, in the order a reader scans it. Every core is the
 * resting state and gets no words; a cap is a decision and gets the width. */
test(`says a sandbox's share as one line, and only the parts somebody set`, () => {
    const row = { slug: `work`, running: true, image: `img` };
    expect(resourcesSummary({ ...row, resources: share({ gpu: true }) })).toBe(`12 GiB · 4 CPUs · privileged · GPU`);
    expect(resourcesSummary({ ...row, resources: share({ cpus: undefined, privileged: false }) })).toBe(`12 GiB`);
    expect(resourcesSummary({ ...row, resources: share({ cpus: 1, privileged: false }) })).toBe(`12 GiB · 1 CPU`);
    // A cap set by hand off the GiB grid keeps its decimal rather than reading as the whole number below it.
    expect(resourcesSummary({ ...row, resources: share({ memoryBytes: 12.5 * GIB, cpus: undefined, privileged: false }) })).toBe(`12.5 GiB`);
    expect(resourcesSummary({ ...row, resources: share({ memoryBytes: undefined, cpus: undefined, privileged: false }) })).toBeUndefined();
    // No share reported: no line, rather than a line claiming defaults nobody read off the container.
    expect(resourcesSummary(row)).toBeUndefined();
});
