import { SAMPLE_EVERY_MS } from "./wsl-memory-fit.js";
import { startWslMemoryWatch } from "./wsl-memory-watch.js";

// The Windows side's watch over rog-like hours: a reading every five minutes, the finding once three hours of them say so.

const GIB = 1024 ** 3;
const START = 1_800_000_000_000;

interface Config {
    text: string | undefined;
}

const rogWatch = (config: Config = { text: "[wsl2]\nmemory=22GB\n" }) => {
    let now = START;
    let vmReads = 0;
    let capReads = 0;
    const lines: string[] = [];
    const watch = startWslMemoryWatch((line) => void lines.push(line), {
        // 2.6 GiB available of 31.4, the VM holding 16.3 in RAM and 19.8 in all: Windows' own use 12.5.
        read: () => ({ availableBytes: 2.6 * GIB, totalBytes: 31.4 * GIB }),
        vm: async () => {
            vmReads += 1;
            return { workingSetBytes: 16.3 * GIB, privateBytes: 19.8 * GIB };
        },
        config: async () => config.text,
        caps: async () => {
            capReads += 1;
            return [{ name: "shinobi", memoryBytes: 18 * GIB }];
        },
        configPath: "C:\\Users\\radar\\.wslconfig",
        now: () => now,
    });
    return {
        watch,
        lines,
        advance: (ms: number) => {
            now += ms;
        },
        reads: () => ({ vm: vmReads, caps: capReads }),
    };
};

test("a reading every five minutes, and the finding once there are hours of them", async () => {
    const rog = rogWatch();
    await rog.watch.pass();
    expect(rog.watch.current()).toEqual({ configPath: "C:\\Users\\radar\\.wslconfig", configuredGb: 22 });
    // A tick within the five minutes reads nothing.
    rog.advance(SAMPLE_EVERY_MS - 1);
    await rog.watch.pass();
    expect(rog.reads().vm).toBe(1);
    for (let reading = 1; reading < 37; reading += 1) {
        rog.advance(SAMPLE_EVERY_MS);
        await rog.watch.pass();
    }
    // 37 readings over three hours: enough.
    const fit = rog.watch.current()?.fit;
    expect(fit?.proposedGb).toBe(15);
    expect(fit?.text).toContain("while the WSL VM held a median 16.3 GiB in RAM and Windows had pushed a median 3.5 GiB more of it out of RAM;");
    // The heartbeat's figure carries both.
    expect(rog.watch.vm()).toEqual({ workingSetBytes: 16.3 * GIB, privateBytes: 19.8 * GIB, at: START + SAMPLE_EVERY_MS * 37 - 1 });
    expect(fit?.capsOver).toEqual([{ name: "shinobi", memoryBytes: 18 * GIB }]);
    // ic's listing only once there was something to say.
    expect(rog.reads().caps).toBe(1);
    expect(rog.lines).toEqual([expect.stringMatching(/^the WSL VM is too big for this PC, proposing memory=15GB: /)]);
});

test("after .wslconfig changed, the next decision reads it again and the finding goes", async () => {
    const config: Config = { text: "[wsl2]\nmemory=22GB\n" };
    const rog = rogWatch(config);
    for (let reading = 0; reading < 40; reading += 1) {
        await rog.watch.pass();
        rog.advance(SAMPLE_EVERY_MS);
    }
    expect(rog.watch.current()?.fit?.proposedGb).toBe(15);
    config.text = "[wsl2]\n# Changed …\nmemory=15GB\n";
    await rog.watch.reread();
    expect(rog.watch.current()).toEqual({ configPath: "C:\\Users\\radar\\.wslconfig", configuredGb: 15 });
    expect(rog.lines.at(-1)).toBe("the WSL VM fits this PC again: no smaller memory= proposed.");
});

test("a failing read is said once and absorbed", async () => {
    const lines: string[] = [];
    let now = START;
    const watch = startWslMemoryWatch((line) => void lines.push(line), {
        read: () => ({ availableBytes: 2.6 * GIB, totalBytes: 31.4 * GIB }),
        vm: async () => {
            throw new Error("tasklist timed out");
        },
        config: async () => undefined,
        caps: async () => [],
        configPath: "C:\\Users\\radar\\.wslconfig",
        now: () => now,
    });
    await watch.pass();
    now += SAMPLE_EVERY_MS;
    await watch.pass();
    expect(lines).toEqual(["watching whether the WSL VM fits this PC: reading vmmemWSL failed (tasklist timed out)"]);
    expect(watch.current()).toBeUndefined();
});
