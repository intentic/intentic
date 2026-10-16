// Which of the owner's sandboxes carries a press to a machine, so a screen offers a button instead of a command to type
// out there. Machines named after the owner's own: rog holds the box, omen holds none.
import type { Device, DeviceSandbox } from "@intentic/sandbox-contract/schemas/devices";
import { listedDevice } from "../../../testing/listedDevice";
import { doorsHolding, machinesLooked, sandboxDoor, setupDoors } from "./sandboxDoors";

const SLUG = `sandbox-7e8d0ffa8bed`;
const box = (slug: string, over: Partial<DeviceSandbox> = {}): DeviceSandbox => ({ slug, container: `intentic-sandbox-${slug}`, running: true, image: `intentic/sandbox:stable`, ...over });

const holding = (key: string, over: Partial<Device> = {}): Device =>
    listedDevice({ key, label: key, hostId: key, online: true, sandboxes: [box(SLUG)], ...over });
const empty = (key: string, over: Partial<Device> = {}): Device => listedDevice({ key, label: key, hostId: key, online: true, sandboxes: [], ...over });

describe(`sandboxDoor`, () => {
    it(`finds the machine through the sandbox open, as before`, () => {
        expect(sandboxDoor([{ sandboxId: `here`, devices: [empty(`omen`), holding(`rog`)] }], SLUG, `lab`)).toEqual({
            relay: `here`,
            hostId: `rog`,
            machineKey: `rog`,
            machineLabel: `rog`,
            severs: false,
        });
    });

    // The case that printed a command: the machine is connected, only not to the sandbox that happens to be open.
    it(`finds it through a sibling, or through the sandbox acted on, when the open one does not reach it`, () => {
        expect(sandboxDoor([{ sandboxId: `here`, devices: [empty(`omen`)] }, { sandboxId: `other`, devices: [holding(`rog`)] }], SLUG, `lab`)?.relay).toBe(`other`);
        expect(sandboxDoor([{ sandboxId: `here`, devices: [] }, { sandboxId: `lab`, devices: [holding(`rog`)] }], SLUG, `lab`)).toMatchObject({ relay: `lab`, severs: true });
    });

    // Its own daemon dies with the container, so a sandbox that lives on is the one asked when both can reach the machine.
    it(`prefers a sandbox that outlives the press over the one it acts on`, () => {
        const relays = [
            { sandboxId: `lab`, devices: [holding(`rog`)] },
            { sandboxId: `here`, devices: [holding(`rog`)] },
        ];
        expect(sandboxDoor(relays, SLUG, `lab`)).toMatchObject({ relay: `here`, severs: false });
        expect(sandboxDoor([{ sandboxId: `lab`, devices: [holding(`rog`)] }], SLUG, `lab`)).toMatchObject({ relay: `lab`, severs: true });
    });

    it(`offers nothing a press could not reach`, () => {
        expect(sandboxDoor([{ sandboxId: `here`, devices: [holding(`rog`, { online: false })] }], SLUG, `lab`)).toBeUndefined();
        expect(sandboxDoor([{ sandboxId: `here`, devices: [empty(`omen`)] }], SLUG, `lab`)).toBeUndefined();
        expect(sandboxDoor([{ sandboxId: `here`, devices: [holding(`rog`)] }], undefined, `lab`)).toBeUndefined();
    });
});

describe(`doorsHolding`, () => {
    // Two copies of one sandbox: each machine is a choice of which copy goes, named once however many sandboxes see it.
    it(`names every machine holding the sandbox, once each`, () => {
        const relays = [
            { sandboxId: `here`, devices: [holding(`rog`), holding(`omen`)] },
            { sandboxId: `other`, devices: [holding(`rog`)] },
        ];
        expect(doorsHolding(relays, SLUG, `here`).map((door) => [door.machineLabel, door.relay])).toEqual([
            [`rog`, `other`],
            [`omen`, `here`],
        ]);
        expect(doorsHolding(relays, undefined, `here`)).toEqual([]);
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

describe(`setupDoors`, () => {
    // A PC seen as its Windows side and the distro on it: one engine, two doors, and one of them should make the sandbox.
    const pc = (windowsBoxes: DeviceSandbox[], linuxBoxes: DeviceSandbox[]): Device[] => [
        listedDevice({ key: `rog`, label: `rog`, hostId: `rog`, machineId: `m-rog`, online: true, platform: `windows`, sandboxes: windowsBoxes }),
        listedDevice({ key: `rog:wsl`, label: `Arch Linux`, hostId: `rog::wsl:archlinux`, machineId: `m-rog`, online: true, platform: `linux`, sandboxes: linuxBoxes }),
    ];

    it(`adds to the side that already keeps the owner's sandboxes there`, () => {
        const kept = box(`sandbox-a`);
        const seenFromWindows = box(`sandbox-a`, { keptElsewhere: `linux/archlinux` });
        expect(setupDoors([{ sandboxId: `here`, devices: pc([seenFromWindows], [kept]) }])).toMatchObject([{ hostId: `rog::wsl:archlinux`, machineLabel: `rog` }]);
        expect(setupDoors([{ sandboxId: `here`, devices: pc([kept], [box(`sandbox-a`, { keptElsewhere: `windows` })]) }])).toMatchObject([{ hostId: `rog` }]);
    });

    it(`takes the Linux side of a PC that keeps none yet`, () => {
        expect(setupDoors([{ sandboxId: `here`, devices: pc([], []) }])).toMatchObject([{ hostId: `rog::wsl:archlinux` }]);
    });

    // Listing its containers is the proof that ic and an engine answer there; a machine that could not is no offer.
    it(`offers only machines that are online and listed their containers, once each across sandboxes`, () => {
        const relays = [
            { sandboxId: `here`, devices: [empty(`omen`), listedDevice({ key: `air`, label: `air`, hostId: `air`, online: true }), empty(`mini`, { online: false })] },
            { sandboxId: `other`, devices: [empty(`omen`)] },
        ];
        expect(setupDoors(relays).map((door) => [door.machineLabel, door.relay])).toEqual([[`omen`, `here`]]);
    });
});
