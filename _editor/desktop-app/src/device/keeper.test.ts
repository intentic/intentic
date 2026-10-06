import type { MachineEnvironment } from "../desktop";
import { environmentLabel, keptBy, otherAgents } from "./keeper";

const windows: MachineEnvironment = { kind: `windows`, here: true, agent: true, running: true, ic: true };
const arch: MachineEnvironment = { kind: `wsl`, distro: `archlinux`, here: false, agent: true, running: true, ic: true };
const ubuntu: MachineEnvironment = { kind: `wsl`, distro: `Ubuntu`, here: false, agent: true, running: false, ic: false };

describe(`keptBy`, () => {
    it(`says nothing of this side's own sandbox`, () => {
        expect(keptBy({}, [windows, arch])).toBeUndefined();
        expect(keptBy({ keptElsewhere: `` }, [windows, arch])).toBeUndefined();
    });

    it(`names the distro ic stamped on the container, whatever runs`, () => {
        expect(keptBy({ keptElsewhere: `linux/Debian` }, [windows, arch])).toBe(`WSL (Debian)`);
        expect(keptBy({ keptElsewhere: `wsl:Debian` }, [windows])).toBe(`WSL (Debian)`);
        expect(keptBy({ keptElsewhere: `archlinux` }, [windows])).toBe(`WSL (archlinux)`);
    });

    it(`names the one distro whose agent runs, and no distro when it cannot tell which`, () => {
        expect(keptBy({ keptElsewhere: `linux` }, [windows, arch, ubuntu])).toBe(`WSL (archlinux)`);
        const debian: MachineEnvironment = { ...arch, distro: `Debian` };
        expect(keptBy({ keptElsewhere: `linux` }, [windows, arch, debian])).toBe(`WSL`);
        expect(keptBy({ keptElsewhere: `linux` }, [windows])).toBe(`WSL`);
    });

    it(`names Windows for a sandbox Windows keeps`, () => {
        expect(keptBy({ keptElsewhere: `windows` }, [])).toBe(`Windows`);
        // What ic says since it stamps the environment: `platform/env`, and the side's own name beside it.
        expect(keptBy({ keptElsewhere: `linux/archlinux` }, [windows])).toBe(`WSL (archlinux)`);
        expect(keptBy({ keptElsewhere: `linux/archlinux`, keptElsewhereName: `WSL (archlinux)` }, [])).toBe(`WSL (archlinux)`);
        expect(keptBy({ keptElsewhere: `windows/windows` }, [])).toBe(`Windows`);
    });
});

describe(`otherAgents`, () => {
    it(`lists the other environments whose agent runs, never this one's`, () => {
        expect(otherAgents([windows, arch, ubuntu])).toEqual([`WSL (archlinux)`]);
        expect(otherAgents([windows])).toEqual([]);
        expect(environmentLabel({ kind: `linux` })).toBe(`Linux`);
        expect(environmentLabel({ kind: `wsl` })).toBe(`WSL`);
    });
});
