// Which of the owner's sandboxes carries a removal to the machine holding the container, so the remove dialog offers a
// press instead of a command to type out there. Machines named after the owner's own: rog holds the box, omen holds none.
import type { Device } from "@intentic/sandbox-contract";
import { listedDevice } from "../../../testing/listedDevice";
import { machinesLooked, removalDoor } from "./removalDoor";

const SLUG = `sandbox-7e8d0ffa8bed`;

const holding = (key: string, over: Partial<Device> = {}): Device =>
    listedDevice({
        key,
        label: key,
        hostId: key,
        online: true,
        sandboxes: [{ slug: SLUG, container: `intentic-sandbox-${SLUG}`, running: true, image: `intentic/sandbox:stable` }],
        ...over,
    });
const empty = (key: string, over: Partial<Device> = {}): Device => listedDevice({ key, label: key, hostId: key, online: true, sandboxes: [], ...over });

describe(`removalDoor`, () => {
    it(`finds the machine through the sandbox open, as before`, () => {
        expect(removalDoor([{ sandboxId: `here`, devices: [empty(`omen`), holding(`rog`)] }], SLUG, `lab`)).toEqual({
            relay: `here`,
            hostId: `rog`,
            machineKey: `rog`,
            machineLabel: `rog`,
            severs: false,
        });
    });

    // The case that printed a command: the machine is connected, only not to the sandbox that happens to be open.
    it(`finds it through a sibling, or through the sandbox being removed, when the open one does not reach it`, () => {
        expect(removalDoor([{ sandboxId: `here`, devices: [empty(`omen`)] }, { sandboxId: `other`, devices: [holding(`rog`)] }], SLUG, `lab`)?.relay).toBe(`other`);
        expect(removalDoor([{ sandboxId: `here`, devices: [] }, { sandboxId: `lab`, devices: [holding(`rog`)] }], SLUG, `lab`)).toMatchObject({ relay: `lab`, severs: true });
    });

    // Its own daemon dies with the container, so a sandbox that lives on is the one asked when both can reach the machine.
    it(`prefers a sandbox that outlives the removal over the one being removed`, () => {
        const relays = [
            { sandboxId: `lab`, devices: [holding(`rog`)] },
            { sandboxId: `here`, devices: [holding(`rog`)] },
        ];
        expect(removalDoor(relays, SLUG, `lab`)).toMatchObject({ relay: `here`, severs: false });
        expect(removalDoor([{ sandboxId: `lab`, devices: [holding(`rog`)] }], SLUG, `lab`)).toMatchObject({ relay: `lab`, severs: true });
    });

    it(`offers nothing a press could not reach`, () => {
        expect(removalDoor([{ sandboxId: `here`, devices: [holding(`rog`, { online: false })] }], SLUG, `lab`)).toBeUndefined();
        expect(removalDoor([{ sandboxId: `here`, devices: [empty(`omen`)] }], SLUG, `lab`)).toBeUndefined();
        expect(removalDoor([{ sandboxId: `here`, devices: [holding(`rog`)] }], undefined, `lab`)).toBeUndefined();
    });
});

describe(`machinesLooked`, () => {
    it(`names each machine that listed its containers once, however many sandboxes reach it`, () => {
        expect(machinesLooked([{ sandboxId: `here`, devices: [empty(`omen`), holding(`rog`)] }, { sandboxId: `other`, devices: [empty(`omen`)] }])).toEqual([`omen`, `rog`]);
    });

    // "It isn't on omen" is only true of a machine that looked: one asleep, or one refusing to list, said nothing.
    it(`leaves out a machine that is offline or would not list`, () => {
        expect(machinesLooked([{ sandboxId: `here`, devices: [empty(`omen`, { online: false }), listedDevice({ key: `rog`, label: `rog`, hostId: `rog`, online: true })] }])).toEqual([]);
    });
});
