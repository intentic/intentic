import type { MemoryReclaimResult } from "@intentic/sandbox-contract/schemas/metrics";
import type { MachineHost, MachineLoad } from "@intentic/sandbox-contract/schemas/offload";
import { hostTip, movedLine, offersReclaim, reclaimWords, suggestLine } from "./fleetWords";

// The composer's "this machine is busy" line names what is short in figures its owner can check (2026-11-26). On rog the
// old line said "only 1.9 GB of memory free": Windows' Available less a 3.1 GB line nobody could see, while the sandbox
// had 10.5 GB and the WSL VM held 16.6 GB. Each case is a reading a person would recognise from Task Manager.

const MB = 1024;

// rog: 31.4 GiB, Windows at 4.2 GB available, its 3.1 GB line kept back, the VM holding 16.6 GB of which 3.5 GB is free
// inside it but stranded, and the sandbox itself with 10.5 GB to spare.
const ROG: MachineHost = {
    name: `rog`,
    availableMb: 4.2 * MB,
    totalMb: 31.4 * MB,
    reserveMb: 3.1 * MB,
    vmMb: 16.6 * MB,
    vmUnusedMb: 3.5 * MB,
    ownFreeMb: 10.5 * MB,
    binding: true,
};

const load = (overrides: Partial<MachineLoad> = {}): MachineLoad => ({
    standing: `busy`,
    strain: [`memory`],
    cpus: 16,
    load: 0.2,
    memoryFreeMb: 1.1 * MB,
    memoryLimitMb: 31 * MB,
    diskFreeMb: 200 * MB,
    agents: 2,
    slots: 8,
    headroom: 0.1,
    ...overrides,
});

describe(`the line while the computer under this sandbox is short`, () => {
    it(`names Windows' own Available and what WSL holds of it, as the reading has them`, () => {
        expect(suggestLine(load({ host: ROG }), `omen`)).toBe(
            `rog is short of memory: Windows has 4.2 GB available, and WSL holds 16.6 GB (3.5 GB of it unused). omen has room for this session.`,
        );
    });

    it(`leaves out the VM's unused part when the agent did not read it, or it rounds to nothing`, () => {
        const { vmUnusedMb: _unused, ...unread } = ROG;
        expect(suggestLine(load({ host: unread }), `omen`)).toBe(`rog is short of memory: Windows has 4.2 GB available, and WSL holds 16.6 GB. omen has room for this session.`);
        expect(suggestLine(load({ host: { ...ROG, vmUnusedMb: 40 } }), `omen`)).toBe(
            `rog is short of memory: Windows has 4.2 GB available, and WSL holds 16.6 GB. omen has room for this session.`,
        );
    });

    it(`says Windows' figure alone when the agent read nothing of the VM`, () => {
        const host: MachineHost = { name: `rog`, availableMb: ROG.availableMb, totalMb: ROG.totalMb, reserveMb: ROG.reserveMb, binding: true };
        expect(suggestLine(load({ host }), `omen`)).toBe(`rog is short of memory: Windows has 4.2 GB available. omen has room for this session.`);
    });

    it(`says the same once the fleet moved the draft by itself`, () => {
        expect(movedLine(load({ host: ROG }), `omen`)).toBe(
            `Starting on omen, since rog is short of memory: Windows has 4.2 GB available, and WSL holds 16.6 GB (3.5 GB of it unused).`,
        );
    });

    it(`keeps the generic line when something else is the strongest strain, with Windows' figure for the memory part`, () => {
        expect(suggestLine(load({ host: ROG, standing: `full`, strain: [`agents`, `memory`], agents: 8 }), `omen`)).toBe(
            `This machine is busy: 8 agents running and Windows has only 4.2 GB of memory available. omen has room for this session.`,
        );
    });
});

describe(`the line while this sandbox's own budget is what is short`, () => {
    it(`says "this sandbox", not the machine`, () => {
        expect(suggestLine(load({ host: { ...ROG, availableMb: 20 * MB, binding: false } }), `omen`)).toBe(
            `This machine is busy: this sandbox has only 1.1 GB of memory free. omen has room for this session.`,
        );
    });
});

describe(`the line from a host that says nothing of its memory`, () => {
    // A Linux host, or a Windows agent older than the reading: the sentence it always had.
    it(`keeps the old sentence`, () => {
        expect(suggestLine(load(), `omen`)).toBe(`This machine is busy: only 1.1 GB of memory free. omen has room for this session.`);
        expect(movedLine(load(), `omen`)).toBe(`Starting on omen: this machine is busy (only 1.1 GB of memory free).`);
        expect(hostTip(load(), false)).toBeUndefined();
    });
});

describe(`the hover behind the line`, () => {
    it(`shows every figure the line is drawn from, the line Windows keeps for itself included`, () => {
        expect(hostTip(load({ host: ROG }), false)).toEqual({
            title: `Memory on rog`,
            rows: [
                { label: `Windows available`, value: `4.2 GB` },
                { label: `Kept free for Windows`, value: `3.1 GB` },
                { label: `Left for new work`, value: `1.1 GB` },
                { label: `Held by WSL`, value: `16.6 GB` },
                { label: `Unused inside WSL`, value: `3.5 GB` },
                { label: `Free in this sandbox`, value: `10.5 GB` },
            ],
            note: undefined,
        });
    });

    it(`points at the WSL size card while one waits, without saying it again`, () => {
        expect(hostTip(load({ host: ROG }), true)?.note).toBe(`A card proposes a smaller WSL size`);
    });
});

describe(`whether "Free memory" is offered`, () => {
    it(`only while the computer is what is short and the daemon says a press could reclaim`, () => {
        expect(offersReclaim({ here: load({ host: ROG }), reclaim: true })).toBe(true);
        expect(offersReclaim({ here: load({ host: ROG }), reclaim: false })).toBe(false);
        // An older daemon says nothing of it.
        expect(offersReclaim({ here: load({ host: ROG }) })).toBe(false);
        expect(offersReclaim({ here: load({ host: { ...ROG, binding: false } }), reclaim: true })).toBe(false);
        expect(offersReclaim({ here: load(), reclaim: true })).toBe(false);
        expect(offersReclaim({ here: load({ host: ROG, strain: [`cpu`] }), reclaim: true })).toBe(false);
    });
});

describe(`what a press came to`, () => {
    const GB = 1024 ** 3;
    const reclaimed = (givenGb: number, beforeGb: number, afterGb: number): MemoryReclaimResult => ({
        outcome: `reclaimed`,
        givenBytes: Math.round(givenGb * GB),
        host: { name: `rog`, beforeBytes: Math.round(beforeGb * GB), afterBytes: Math.round(afterGb * GB) },
    });

    it(`says what Windows gained`, () => {
        expect(reclaimWords(reclaimed(1.5, 4.2, 5.4))).toBe(`Windows gained 1.2 GB: it has 5.4 GB available now.`);
    });

    it(`says plainly when Windows got none of it, a move inside its own noise included`, () => {
        expect(reclaimWords(reclaimed(1, 4.2, 4.15))).toBe(`Windows got nothing back: this sandbox let go of 1.0 GB, but WSL kept it.`);
        expect(reclaimWords(reclaimed(1, 4.2, 4.25))).toBe(`Windows got nothing back: this sandbox let go of 1.0 GB, but WSL kept it.`);
    });

    it(`says when the sandbox had nothing to let go of, and when the computer stopped answering`, () => {
        expect(reclaimWords(reclaimed(0, 4.2, 6))).toBe(`Nothing came back: this sandbox had nothing it could let go of.`);
        expect(reclaimWords({ outcome: `reclaimed`, givenBytes: GB, host: { name: `rog`, beforeBytes: 4.2 * GB } })).toBe(`This sandbox let go of 1.0 GB, but rog didn't say what Windows has now.`);
    });

    it(`says why nothing was tried`, () => {
        expect(reclaimWords({ outcome: `refused`, why: `stalling` })).toBe(`Not now: this sandbox is short of memory itself.`);
        expect(reclaimWords({ outcome: `refused`, why: `no-host` })).toBe(`Nothing to free from here: this computer doesn't say what memory it has.`);
    });
});
