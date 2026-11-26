import {
    applyWslMemory,
    backupName,
    changeComment,
    configuredGb,
    localDate,
    memoryValue,
    sizeGb,
    withMemory,
    type WslconfigIo,
} from "./wslconfig-memory.js";
import { asZone, UTC } from "@intentic/sandbox-contract/time/zone";

// rog's .wslconfig as it stood on 2026-11-26: the owner's own notebook, every change dated and explained.
const ROG = `# Changed 2026-08-24 after tracing the sandbox/model crash. Previous file: .wslconfig.bak.2026-08-24
#
# swap: 32GB -> 8GB -> 16GB
#
# The 8 GB bound exposed an existing overcommit (two llama servers, forced full GPU
# offload, and no container cgroup limit) by exhausting total commit during ordinary
# rebuild/model activity. Those root causes are now bounded in the sandbox. 16 GB is
# the middle ground: enough runway for a short compiler/model peak without restoring
# the 32 GB swap storm that made both WSL and Windows page on the same NVMe for hours.

[wsl2]
# Keep 22GB of 31.4GB physical. The sandbox container runs at 18GB RAM (14GB was tried on
# 2026-10-21 and was too tight), leaving ~4GB for the editor dev servers, VS Code and the
# guest. Its swap is not bounded by Docker.
memory=22GB
processors=16
swap=22GB
# Swappiness is NOT set here. 2026-10-21: this file passed sysctl.vm.swappiness=10 on the kernel
# command line, but /etc/sysctl.d/99-zram-tuning.conf (vm.swappiness=150) is applied after boot
# and won, so 10 was never in effect.

[experimental]
# Changed 2026-10-13 from 'gradual' to 'dropcache': page cache is dropped once the VM is idle.
autoMemoryReclaim=dropcache
sparseVhd=false
`;

const COMMENT = "# Changed 2026-11-26 from 22GB to 15GB by intentic-machine, at the owner's yes on a sandbox card: why. Previous file: .wslconfig.bak.2026-11-26";

test("sizes read as WSL reads them, in GiB", () => {
    expect(sizeGb("22GB")).toBe(22);
    expect(sizeGb("16384MB")).toBe(16);
    expect(sizeGb("8g")).toBe(8);
    expect(sizeGb(" 12 GB ")).toBe(12);
    expect(sizeGb("lots")).toBeUndefined();
    expect(configuredGb(ROG)).toBe(22);
    expect(memoryValue(ROG)).toBe("22GB");
    // A memory= outside [wsl2] is not the VM's.
    expect(configuredGb("[experimental]\nmemory=4GB\n")).toBeUndefined();
});

test("rog's file: only the memory= line changes, with the dated line above it; every comment stays", () => {
    const after = withMemory(ROG, 15, COMMENT);
    const before = ROG.split("\n");
    const lines = after.split("\n");
    expect(lines).toHaveLength(before.length + 1);
    const at = before.indexOf("memory=22GB");
    expect(lines.slice(0, at)).toEqual(before.slice(0, at));
    expect(lines[at]).toBe(COMMENT);
    expect(lines[at + 1]).toBe("memory=15GB");
    expect(lines.slice(at + 2)).toEqual(before.slice(at + 1));
    expect(configuredGb(after)).toBe(15);
});

test("CRLF line endings stay CRLF", () => {
    const crlf = ROG.replaceAll("\n", "\r\n");
    const after = withMemory(crlf, 15, COMMENT);
    expect(after).toBe(withMemory(ROG, 15, COMMENT).replaceAll("\n", "\r\n"));
    expect(after.replaceAll("\r\n", "")).not.toContain("\n");
});

test("the line WSL reads is changed, indent kept; one under [wsl2] where there is none; a section where there is none", () => {
    expect(withMemory("[wsl2]\n  memory = 22GB\nswap=8GB\n", 15, "# c")).toBe("[wsl2]\n  # c\n  memory=15GB\nswap=8GB\n");
    expect(withMemory("# mine\n[wsl2]\nswap=8GB\n", 15, "# c")).toBe("# mine\n[wsl2]\n# c\nmemory=15GB\nswap=8GB\n");
    expect(withMemory("# mine\n[experimental]\nsparseVhd=false\n", 15, "# c")).toBe("# mine\n[experimental]\nsparseVhd=false\n\n[wsl2]\n# c\nmemory=15GB\n");
    expect(withMemory("[experimental]\nsparseVhd=false", 15, "# c")).toBe("[experimental]\nsparseVhd=false\n\n[wsl2]\n# c\nmemory=15GB\n");
    expect(withMemory("", 15, "# c")).toBe("[wsl2]\n# c\nmemory=15GB\n");
    // A header spelled another way is still [wsl2].
    expect(withMemory("[WSL2]\nMemory=22GB\n", 15, "# c")).toBe("[WSL2]\n# c\nmemory=15GB\n");
});

test("the dated line says who, from what, why and where the old file went, on one line", () => {
    expect(changeComment({ date: "2026-11-26", from: "22GB", gb: 15, why: "Windows was short\nfor hours.", backup: ".wslconfig.bak.2026-11-26" })).toBe(
        "# Changed 2026-11-26 from 22GB to 15GB by intentic-machine, at the owner's yes on a sandbox card: Windows was short for hours. Previous file: .wslconfig.bak.2026-11-26",
    );
    expect(changeComment({ date: "2026-11-26", from: undefined, gb: 15, why: "why", backup: undefined })).toBe(
        "# Changed 2026-11-26 (memory= was not set) to 15GB by intentic-machine, at the owner's yes on a sandbox card: why.",
    );
});

test("a backup never takes a name already there", () => {
    expect(backupName(".wslconfig", "2026-11-26", () => false)).toBe(".wslconfig.bak.2026-11-26");
    const taken = new Set([".wslconfig.bak.2026-11-26", ".wslconfig.bak.2026-11-26.2"]);
    expect(backupName(".wslconfig", "2026-11-26", (name) => taken.has(name))).toBe(".wslconfig.bak.2026-11-26.3");
});

// A folder in memory: what the change read, copied and wrote.
const fakeIo = (files: Map<string, Buffer>): WslconfigIo & { readonly writes: string[] } => {
    const writes: string[] = [];
    return {
        writes,
        read: async (path) => files.get(path),
        names: async (folder) => [...files.keys()].filter((path) => path.startsWith(`${folder}/`)).map((path) => path.slice(folder.length + 1)),
        backup: async (from, to) => {
            const bytes = files.get(from);
            if (bytes === undefined || files.has(to)) {
                throw new Error(`cannot copy ${from} to ${to}`);
            }
            files.set(to, bytes);
            writes.push(to);
        },
        write: async (path, bytes) => {
            files.set(path, bytes);
            writes.push(path);
        },
    };
};

// 14:30 in Warsaw, the owner's zone; 00:30 there the next day is still the 26th in UTC, and the backup says the 27th.
const NOW = Date.UTC(2026, 10, 26, 13, 30);
const WARSAW = asZone("Europe/Warsaw") ?? UTC;

test("applying backs the file up as it was, then writes the change", async () => {
    const files = new Map([
        ["/home/.wslconfig", Buffer.from(ROG)],
        ["/home/.wslconfig.bak.2026-11-26", Buffer.from("the owner's own backup of this morning")],
    ]);
    const io = fakeIo(files);
    const change = await applyWslMemory(io, { path: "/home/.wslconfig", gb: 15, why: "Windows was under its low line", now: NOW, zone: WARSAW });
    expect(change).toEqual({ path: "/home/.wslconfig", from: "22GB", gb: 15, changed: true, backupPath: "/home/.wslconfig.bak.2026-11-26.2" });
    expect(io.writes).toEqual(["/home/.wslconfig.bak.2026-11-26.2", "/home/.wslconfig"]);
    expect(files.get("/home/.wslconfig.bak.2026-11-26.2")?.toString()).toBe(ROG);
    expect(files.get("/home/.wslconfig.bak.2026-11-26")?.toString()).toBe("the owner's own backup of this morning");
    const written = files.get("/home/.wslconfig")?.toString() ?? "";
    expect(configuredGb(written)).toBe(15);
    expect(written).toContain(
        "# Changed 2026-11-26 from 22GB to 15GB by intentic-machine, at the owner's yes on a sandbox card: Windows was under its low line. Previous file: .wslconfig.bak.2026-11-26.2\nmemory=15GB\n",
    );
    // Everything but the one line, and the line added above it, is as it was.
    expect(written.split("\n").filter((line) => !line.startsWith("# Changed 2026-11-26") && line !== "memory=15GB")).toEqual(ROG.split("\n").filter((line) => line !== "memory=22GB"));
});

test("a UTF-16 file with a byte-order mark is written back the same way", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("[wsl2]\r\nmemory=22GB\r\n", "utf16le")]);
    const files = new Map([["/home/.wslconfig", utf16]]);
    await applyWslMemory(fakeIo(files), { path: "/home/.wslconfig", gb: 15, why: "why", now: NOW, zone: WARSAW });
    const written = files.get("/home/.wslconfig");
    expect([written?.[0], written?.[1]]).toEqual([0xff, 0xfe]);
    expect(written?.subarray(2).toString("utf16le")).toBe(
        "[wsl2]\r\n# Changed 2026-11-26 from 22GB to 15GB by intentic-machine, at the owner's yes on a sandbox card: why. Previous file: .wslconfig.bak.2026-11-26\r\nmemory=15GB\r\n",
    );
});

test("a file already at that size is left alone, and a missing one is created with no backup", async () => {
    const files = new Map([["/home/.wslconfig", Buffer.from("[wsl2]\nmemory=15GB\n")]]);
    const io = fakeIo(files);
    expect((await applyWslMemory(io, { path: "/home/.wslconfig", gb: 15, why: "why", now: NOW, zone: WARSAW })).changed).toBe(false);
    expect(io.writes).toEqual([]);

    const empty = new Map<string, Buffer>();
    const created = await applyWslMemory(fakeIo(empty), { path: "/home/.wslconfig", gb: 15, why: "why", now: NOW, zone: WARSAW });
    expect(created).toMatchObject({ changed: true, from: undefined, backupPath: undefined });
    expect(empty.get("/home/.wslconfig")?.toString()).toBe("[wsl2]\n# Changed 2026-11-26 (memory= was not set) to 15GB by intentic-machine, at the owner's yes on a sandbox card: why.\nmemory=15GB\n");
});

test("dates are the PC's own calendar day, in its own zone", () => {
    expect(localDate(NOW, WARSAW)).toBe("2026-11-26");
    expect(localDate(Date.UTC(2026, 10, 26, 23, 30), WARSAW)).toBe("2026-11-27");
});
