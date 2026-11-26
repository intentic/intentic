import { errorMessage } from "@intentic/base/errors";
import { execBounded } from "@intentic/base/process";
import type { Log } from "@intentic/local-agent";
import type { HostMemory, HostVmMemory } from "@intentic/sandbox-contract/schemas/hosts";
import type { WslMemory, WslMemoryCap, WslMemoryFit } from "@intentic/sandbox-contract/schemas/wsl-memory";
import { fleet } from "../device/tools/listing/sandbox-fleet.js";
import { encodedCommand } from "../power/windows-reading.js";
import { windowsMemory } from "./windows-memory.js";
import {
    FIT_WINDOW_MS,
    SAMPLE_EVERY_MS,
    type VmFootprint,
    vmBytesFromTasklist,
    vmFromGetProcess,
    withCaps,
    type WslMemoryReading,
    wslMemoryFit,
} from "./wsl-memory-fit.js";
import { configuredGb, readWslconfigText, wslconfigPath } from "./wslconfig-memory.js";

/* The Windows side's resident agent watching whether the WSL VM fits its PC (wsl-memory-fit.ts says how it decides):
   one reading every SAMPLE_EVERY_MS on its tick, of Windows' available memory (`os.freemem()`, as the heartbeat reads
   it) and vmmemWSL's working set and private bytes (`Get-Process`, a PowerShell at about 0.35 s of CPU a go; `tasklist`,
   about 150 ms on rog, for the working set alone where PowerShell fails). The private bytes are worth the PowerShell
   (2026-11-26): rog's VM held 21.7 GiB private against an 18.2 GiB working set, Windows having pushed the rest out of
   RAM, so the working set alone understated the VM by 3.5 GiB. Four hours of readings are kept in memory, never on disk: an agent
   that restarts (an update) decides nothing for three hours, which only delays a card that is about hours anyway.
   Each reading decides again, reading `.wslconfig` for what the VM may take now and, only once the VM is too big,
   ic's listing for the sandboxes' caps. The device's facts carry the result (`DeviceFacts.wslMemory`). */

// Both answer in under a second; the deadline is for a Windows that is paging hard, which is when this runs.
const READ_TIMEOUT_MS = 20_000;

// `<working set> <private bytes>` of vmmemWSL, nothing when the VM is not running (vmFromGetProcess reads it).
const VM_SCRIPT = "$p = Get-Process -Name vmmemWSL -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { '{0} {1}' -f $p.WorkingSet64, $p.PrivateMemorySize64 }";

const readVmByGetProcess = async (): Promise<VmFootprint | undefined> => {
    try {
        const { stdout } = await execBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(VM_SCRIPT)], { timeoutMs: READ_TIMEOUT_MS });
        return vmFromGetProcess(stdout);
    } catch {
        // allow(silent-catch): a PowerShell that cannot run here leaves the working set to tasklist, whose failure is said.
        return undefined;
    }
};

const readVm = async (): Promise<VmFootprint> => {
    const read = await readVmByGetProcess();
    if (read !== undefined) {
        return read;
    }
    const { stdout } = await execBounded("tasklist.exe", ["/FI", "IMAGENAME eq vmmemWSL", "/FO", "CSV", "/NH"], { timeoutMs: READ_TIMEOUT_MS });
    return { workingSetBytes: vmBytesFromTasklist(stdout) };
};

// The sandboxes' container caps on this PC, as ic lists them (the listing every reader here shares): only those with one.
const readCaps = async (): Promise<WslMemoryCap[]> =>
    (await fleet({ current: false })).flatMap((row) => {
        const memoryBytes = row.resources?.memoryBytes;
        return memoryBytes === undefined ? [] : [{ name: row.name ?? row.slug, memoryBytes }];
    });

const CAPS = "listing the sandboxes' caps";

// The caps, or none where ic could not list them: said once through `failed`, until a listing works (`worked`).
const capsOr = async (caps: () => Promise<WslMemoryCap[]>, failed: (what: string, why: string) => void, worked: () => void): Promise<WslMemoryCap[]> => {
    try {
        const listed = await caps();
        worked();
        return listed;
    } catch (error) {
        failed(CAPS, errorMessage(error));
        return [];
    }
};

// What the facts carry: the file, what it sets, and the finding where there is one. Pure.
const factsOf = (configPath: string, configured: number | undefined, fit: WslMemoryFit | undefined): WslMemory => {
    const facts: WslMemory = { configPath };
    if (configured !== undefined) {
        facts.configuredGb = configured;
    }
    if (fit !== undefined) {
        facts.fit = fit;
    }
    return facts;
};

export interface WslMemoryWatchDeps {
    readonly read?: () => HostMemory | undefined;
    readonly vm?: () => Promise<VmFootprint>;
    // `.wslconfig` as text, undefined where there is none.
    readonly config?: () => Promise<string | undefined>;
    readonly caps?: () => Promise<WslMemoryCap[]>;
    readonly configPath?: string;
    readonly now?: () => number;
}

export interface WslMemoryWatch {
    // Takes a reading when one is due, beside the tick: never throws and never holds it.
    readonly tick: () => void;
    // What the facts carry: undefined until `.wslconfig` was read once.
    readonly current: () => WslMemory | undefined;
    // vmmemWSL's working set and private bytes as last read, for the heartbeat (HostMemory `vm`): undefined until read.
    readonly vm: () => HostVmMemory | undefined;
    // Reads `.wslconfig` and decides again now, on the readings held: after this agent changed it.
    readonly reread: () => Promise<void>;
    // One pass, awaited: for the tests.
    readonly pass: () => Promise<void>;
}

export const startWslMemoryWatch = (
    log: Log,
    {
        read = windowsMemory,
        vm = readVm,
        config = readWslconfigText,
        caps = readCaps,
        configPath = wslconfigPath(),
        now = Date.now,
    }: WslMemoryWatchDeps = {},
): WslMemoryWatch => {
    let readings: WslMemoryReading[] = [];
    let lastAt = Number.NEGATIVE_INFINITY;
    let state: WslMemory | undefined;
    let vmRead: HostVmMemory | undefined;
    let underway: Promise<void> | undefined;
    // Each failure is said once until that read works again.
    const failing = new Set<string>();
    const failed = (what: string, why: string): void => {
        if (!failing.has(what)) {
            log(`watching whether the WSL VM fits this PC: ${what} failed (${why.split("\n")[0] ?? ""})`);
        }
        failing.add(what);
    };

    const decide = async (): Promise<void> => {
        let text: string | undefined;
        try {
            text = await config();
            failing.delete("reading .wslconfig");
        } catch (error) {
            failed("reading .wslconfig", errorMessage(error));
            return;
        }
        const configured = text === undefined ? undefined : configuredGb(text);
        const base = wslMemoryFit(readings, configured, now());
        // ic's listing only once there is something to say about the caps; a listing that fails costs only the caps.
        const fit = base === undefined ? undefined : withCaps(base, await capsOr(caps, failed, () => failing.delete(CAPS)));
        if (fit?.proposedGb !== state?.fit?.proposedGb) {
            log(fit === undefined ? "the WSL VM fits this PC again: no smaller memory= proposed." : `the WSL VM is too big for this PC, proposing memory=${fit.proposedGb}GB: ${fit.text}`);
        }
        state = factsOf(configPath, configured, fit);
    };

    const sample = async (): Promise<void> => {
        const at = now();
        if (at - lastAt < SAMPLE_EVERY_MS) {
            return;
        }
        lastAt = at;
        const memory = read();
        if (memory === undefined) {
            return;
        }
        let footprint: VmFootprint;
        try {
            footprint = await vm();
            failing.delete("reading vmmemWSL");
        } catch (error) {
            failed("reading vmmemWSL", errorMessage(error));
            return;
        }
        const { workingSetBytes, privateBytes } = footprint;
        vmRead = privateBytes === undefined ? { workingSetBytes, at } : { workingSetBytes, privateBytes, at };
        const reading: WslMemoryReading = { at, availableBytes: memory.availableBytes, totalBytes: memory.totalBytes, vmBytes: workingSetBytes };
        readings = [...readings.filter((kept) => at - kept.at <= FIT_WINDOW_MS), privateBytes === undefined ? reading : { ...reading, vmPrivateBytes: privateBytes }];
        await decide();
    };

    // Whatever goes wrong is said and absorbed here: this runs beside the resident agent's tick, which it must never end.
    const pass = async (): Promise<void> => {
        try {
            await sample();
        } catch (error) {
            failed("a reading", errorMessage(error));
        }
    };
    return {
        pass,
        tick: () => {
            if (underway !== undefined) {
                return;
            }
            underway = pass().finally(() => {
                underway = undefined;
            });
        },
        current: () => state,
        vm: () => vmRead,
        reread: async () => {
            try {
                await decide();
            } catch (error) {
                failed("deciding again", errorMessage(error));
            }
        },
    };
};

let watch: WslMemoryWatch | undefined;

/** Starts this process's watch: the resident agent, on Windows' own side. */
export const watchWslMemory = (log: Log): WslMemoryWatch => (watch ??= startWslMemoryWatch(log));

/** The device facts' `wslMemory`: undefined anywhere but a resident agent on Windows' own side, and until it read `.wslconfig`. */
export const wslMemoryFacts = (): WslMemory | undefined => watch?.current();

/** The heartbeat's `vm`: vmmemWSL's working set and private bytes as the watch last read them; undefined anywhere else, and until then. */
export const wslVmMemory = (): HostVmMemory | undefined => watch?.vm();

/** After this agent changed `.wslconfig` (the `wsl-memory` op): the facts say what it holds now. */
export const rereadWslMemory = async (): Promise<void> => {
    await watch?.reread();
};
