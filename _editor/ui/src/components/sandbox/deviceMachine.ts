// WHAT A MACHINE IS, as both Devices pages draw it: the OS it runs, as the glyph people recognise it by in that OS's own
// colour, and the size of the engine its sandboxes share. DOM-free, so the web Devices view (which reads a daemon's
// device registry) and the desktop app (which reads the computer it runs on) build the same marks and the same words
// from their own facts. Until 2026-10-20 the table lived in the web alone, and the desktop app's page had no mark at all.

import { formatBinaryBytes } from "../../lib/format.js";
import { t } from "../../i18n/index.js";

export interface OsMark {
    readonly icon: string;
    /** The OS's own brand colour, for BrandMark's `tint`; absent for the generic monitor. */
    readonly tint?: string;
}

// Matched against the distro's name and the OS string both, lowercase, first hit wins: the specific distros before
// the generic Linux, and macOS before anything whose name happens to contain "os".
const OS_MARKS: readonly (readonly [RegExp, OsMark])[] = [
    [/\barch/, { icon: `archlinux`, tint: `#1793D1` }],
    [/ubuntu/, { icon: `ubuntu`, tint: `#E95420` }],
    [/debian/, { icon: `debian`, tint: `#A81D33` }],
    [/fedora/, { icon: `fedora`, tint: `#51A2DA` }],
    [/windows/, { icon: `windows`, tint: `#0078D4` }],
    [/macos|mac os|darwin|os x/, { icon: `apple`, tint: `#000000` }],
    [/linux/, { icon: `linux`, tint: `#FCC624` }],
];

const LINUX_MARK: OsMark = { icon: `linux`, tint: `#FCC624` };
const WINDOWS_MARK: OsMark = { icon: `windows`, tint: `#0078D4` };
const APPLE_MARK: OsMark = { icon: `apple`, tint: `#000000` };

// By the platform's slug: the contract's (`windows`, `macos`, `linux`) and Node's, which a machine agent's own report
// carries (`win32`, `darwin`).
const PLATFORM_MARKS: ReadonlyMap<string, OsMark> = new Map([
    [`windows`, WINDOWS_MARK],
    [`win32`, WINDOWS_MARK],
    [`macos`, APPLE_MARK],
    [`darwin`, APPLE_MARK],
    [`linux`, LINUX_MARK],
]);

const GENERIC_MARK: OsMark = { icon: `desktop` };

const markOf = (words: readonly (string | undefined)[]): OsMark | undefined => {
    for (const word of words) {
        const hit = word === undefined || word === `` ? undefined : OS_MARKS.find(([pattern]) => pattern.test(word.toLowerCase()));
        if (hit !== undefined) {
            return hit[1];
        }
    }
    return undefined;
};

/**
 * The mark for an environment: the first of `words` (a distro's name, the OS's own string) that names an OS anyone
 * draws, else Linux for a `linux` side that named none (WSL reports a distro's platform as the Windows side's), else its
 * `platform` slug, else the generic monitor. Never nothing.
 */
export const osMarkOf = (
    words: readonly (string | undefined)[],
    { linux = false, platform }: { readonly linux?: boolean; readonly platform?: string | undefined } = {},
): OsMark => markOf(words) ?? (linux ? LINUX_MARK : undefined) ?? (platform === undefined ? undefined : PLATFORM_MARKS.get(platform)) ?? GENERIC_MARK;

/** A WSL distro known only by the name WSL registered it under: a side of a PC that holds no door yet. */
export const distroMark = (name: string): OsMark => markOf([name]) ?? LINUX_MARK;

/** The engine's size as one line ("22 GiB · 16 cores"): the ceiling every sandbox on the machine shares. */
export const engineCapacity = (engine: { readonly memoryBytes: number; readonly cpus: number }): string =>
    t(`ui.deviceMachine.capacity`, { memory: formatBinaryBytes(engine.memoryBytes), cpus: engine.cpus }, engine.cpus);
