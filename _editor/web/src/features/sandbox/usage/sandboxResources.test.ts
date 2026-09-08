import { expect, test } from "vitest";
import { type DeviceSandboxResources, resourcesSummary } from "@intentic/ui/device";
import { askFrom, capFromField, cpuBounds, formFrom, formProblems, gpuDropped, locksOf, memoryBounds } from "@intentic/ui/sandbox-resources";

// Pins the resources form's arithmetic here (the kit that owns it has no test runner): what it starts from,
// refuses, and sends on Apply. Imported via the deep path, not the barrel, so this doesn't boot the component graph.

const GIB = 1024 ** 3;

// A container as the machine reports it: 12 GiB, 4 cores, privileged (the Docker capability demands it), no GPU.
const share = (overrides: Partial<DeviceSandboxResources> = {}): DeviceSandboxResources => ({
    memoryBytes: 12 * GIB,
    cpus: 4,
    privileged: true,
    gpu: false,
    hostRuntime: [],
    overlayRuntime: [`--privileged`],
    ...overrides,
});

// Whole GiB from a 4 GiB floor to engine-minus-3GiB; whole cores from 1 to the engine's count. A too-small
// machine still offers the floor; an unmeasured one leaves the ceiling open.
test(`bounds a cap by the engine, minus what the host keeps`, () => {
    expect(memoryBounds({ memoryBytes: 20 * GIB, cpus: 12 })).toEqual({ min: 4, max: 17 });
    expect(memoryBounds({ memoryBytes: 6 * GIB, cpus: 2 })).toEqual({ min: 4, max: 4 });
    expect(memoryBounds(undefined)).toEqual({ min: 4 });
    expect(cpuBounds({ memoryBytes: 20 * GIB, cpus: 12 })).toEqual({ min: 1, max: 12 });
    expect(cpuBounds(undefined)).toEqual({ min: 1 });
});

// Caps round down to whole units; absent means the default (empty field). Switches hold the ask, so a
// docker-granted privilege and an owner-asked one both read as on.
test(`opens on the container's own share`, () => {
    expect(formFrom(share())).toEqual({ memoryGib: 12, cpus: 4, privileged: true, gpu: false });
    // 12.5 GiB rounds down to 12: rounding up would offer bytes the machine doesn't grant.
    expect(formFrom(share({ memoryBytes: 12.5 * GIB, cpus: 1.5 })).memoryGib).toBe(12);
    expect(formFrom(share({ cpus: 1.5 })).cpus).toBe(1);
    // Unbounded is the default, not zero: the hosted shape's container carries no cap at all.
    expect(formFrom(share({ memoryBytes: undefined, cpus: undefined }))).toMatchObject({ memoryGib: null, cpus: null });
});

// The one switch where ask and answer can disagree: a host without NVIDIA drops `--gpus`, so the container
// reports no GPU though it's still asked for. Stays on (not silently reset), so Apply doesn't restate an unwithdrawn
// wish.
test(`keeps a dropped GPU asked for, and says so`, () => {
    const dropped = share({ gpu: false, hostRuntime: [`--gpus=all`] });
    expect(formFrom(dropped).gpu).toBe(true);
    expect(gpuDropped(dropped)).toBe(true);
    // Granted, or never asked: nothing to say.
    expect(gpuDropped(share({ gpu: true, hostRuntime: [`--gpus=all`] }))).toBe(false);
    expect(gpuDropped(share())).toBe(false);
});

// Switches the approved environment demands are locked with a reason, not live and silently ignored on Apply;
// the owner's own asks stay unlocked.
test(`locks a privilege the approved environment demands, and only that one`, () => {
    expect(locksOf(share())).toEqual({ privileged: expect.stringContaining(`approved environment`) });
    expect(locksOf(share({ overlayRuntime: [`--privileged`, `--gpus=all`] }))).toEqual({
        privileged: expect.any(String),
        gpu: expect.any(String),
    });
    expect(locksOf(share({ privileged: true, hostRuntime: [`--privileged`], overlayRuntime: [] }))).toEqual({});
});

// A diff in the contract's own ask shape: absent means leave it, `null` on a cap means back to default. Nothing
// changed sends nothing (and Apply is disabled on it).
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

// Errors show under their own field (fraction or out-of-rails); empty is never a problem, it's the default.
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

// Empty is the default; any number passes here (min/max are formProblems' job, advisory only in the browser),
// and not-a-number mid-edit changes nothing.
test(`reads an empty field as the default and leaves a half-typed one alone`, () => {
    expect(capFromField(``)).toBeNull();
    expect(capFromField(`  `)).toBeNull();
    expect(capFromField(`16`)).toBe(16);
    expect(capFromField(`8.5`)).toBe(8.5);
    expect(capFromField(`-1`)).toBe(-1);
    expect(capFromField(`1e`)).toBeUndefined();
});

// Only what was set, in scan order; the resting core count gets no words, a set cap gets the width.
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
