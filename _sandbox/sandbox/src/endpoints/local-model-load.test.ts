import { llamaServerProcesses, type ProcReads } from "./local-model-load.js";

// The scan for this sandbox's own llama-server processes. The machine's own processes are never read here: the
// process scan's case stands in for /proc.

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: read /proc`), { code });

// A /proc whose processes answer as `files` says, each entry a cmdline (NUL-separated) or the error reading it throws.
const procOf = (files: Readonly<Record<string, string | NodeJS.ErrnoException>>): ProcReads => ({
    entries: async () => ["self", ...Object.keys(files)],
    read: async (path) => {
        const [, pid, file] = /^\/proc\/(\d+)\/(cmdline|status)$/u.exec(path) ?? [];
        const answer = pid === undefined ? undefined : files[pid];
        if (answer === undefined) {
            throw errno("ENOENT");
        }
        if (answer instanceof Error) {
            throw answer;
        }
        return file === "status" ? "VmRSS:\t   2048 kB\n" : answer;
    },
});

// Processes come and go while the scan reads them: one gone between the open and the read answers ESRCH, one gone
// before it ENOENT. The idle sweep failed on a quarter of its passes while either failed the whole scan.
test("a process that exits mid-scan is skipped, and the servers still standing are found", async () => {
    const server = ["/opt/llama/llama-server", "--model", "m.gguf", "--port", "4048"].join("\0");
    const servers = await llamaServerProcesses(
        procOf({ "101": server, "102": errno("ESRCH"), "103": errno("ENOENT"), "104": ["bash", "-l"].join("\0") }),
    );
    expect(servers).toEqual([{ pid: 101, port: 4048, residentBytes: 2048 * 1024 }]);
});

test("a /proc read failing for any other reason still fails the scan, rather than hiding a server", async () => {
    await expect(llamaServerProcesses(procOf({ "101": errno("EACCES") }))).rejects.toThrow("EACCES");
});
