import { WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { classifyProcess, ownerOf, parseAuxv, programOf } from "./process-scan.js";

describe("what a process is", () => {
    test("the owner is read out of a NUL-separated environ and ignores every other variable", () => {
        expect(ownerOf(["PATH=/usr/bin", `${WORKLOAD_ENV}=conv-1`, "HOME=/root", ""].join("\0"))).toBe("conv-1");
        expect(ownerOf("PATH=/usr/bin\0")).toBeUndefined();
    });

    test.each([
        ["node /opt/typescript-language-server --stdio", "languageServer"],
        ["node /opt/node_modules/@intentic/lsp/dist/cli.js diag /work/src/a.ts", "languageServer"],
        // Serving the protocol it is a language server; the same binary run once over a project is a typecheck.
        ["/opt/node_modules/@typescript/native-preview-linux-x64/lib/tsgo --lsp --stdio", "languageServer"],
        ["/opt/node_modules/@typescript/native-preview-linux-x64/lib/tsgo --noEmit -p tsconfig.json", "toolchain"],
        // The fan-out, as its members read from /proc: pnpm's `+`/`@` path encoding, a vitest fork, a heap-sized vue-tsc.
        [
            "MainThread /usr/local/bin/node /work/intentic/node_modules/.pnpm/vitest@4.0.9_@types+node@24.1.0/node_modules/vitest/dist/workers/forks.js",
            "toolchain",
        ],
        ["MainThread node --max-old-space-size=4096 ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.app.json", "toolchain"],
        ["turbo turbo run typecheck test --only --continue=dependencies-successful", "toolchain"],
        ["MainThread /usr/local/bin/node /usr/local/share/pnpm/pnpm.cjs verify:turn", "toolchain"],
        ["MainThread node /work/intentic/_site/demo/node_modules/vite/bin/vite.js", "toolchain"],
        ["llama-server llama-server -m /work/.intentic/local/cache/models/Qwen3.5-2B-Q4_K_M.gguf --host 127.0.0.1", "localModel"],
        ["dockerd dockerd", "container"],
        ["containerd-shim /usr/bin/containerd-shim-runc-v2 -namespace moby", "container"],
        ["node /opt/@playwright/mcp/cli.js", "browser"],
        ["/usr/bin/chromium --headless", "browser"],
        ["/usr/local/bin/codex app-server", "agentRuntime"],
        ["git-fork-broker --socket /run/git.sock", "git"],
        ["cli-proxy-api --port 8317", "translator"],
        ["node extension-backend-host.js", "extension"],
        ["tmux: server", "terminal"],
        // pnpm encodes the path with `+`, so nothing in it reads as a directory called iq-engine.
        [
            "MainThread /usr/local/bin/node /opt/sandbox/node_modules/.pnpm/@intentic+iq-engine@file++++work+_search+iq-engine/node_modules/@intentic/iq-engine/dist/host/child.js",
            "searchEngine",
        ],
        ["node /opt/sandbox/node_modules/@intentic/iq-engine/dist/host/child.js", "searchEngine"],
        ["node dist/main.js", "other"],
    ] as const)("classifies %s as %s", (command, role) => {
        expect(classifyProcess(command)).toBe(role);
    });

    test("a nested container's process is the container's whatever it runs, by the cgroup it sits in", () => {
        const nested = "0::/docker/bbf2a98871409a5a18ce9cf5f8bd958cec0d0a76164292f04bea9b6341a238d1";
        expect(classifyProcess("nginx nginx: worker process", nested)).toBe("container");
        expect(classifyProcess("postgres postgres: checkpointer", nested)).toBe("container");
        // The sandbox's own processes sit at the root of their namespace and keep their own roles.
        expect(classifyProcess("nginx nginx: worker process", "0::/")).toBe("other");
        expect(classifyProcess("MainThread node /opt/vitest/dist/workers/forks.js", "0::/")).toBe("toolchain");
    });

    test.each([
        ["MainThread node ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit", "vue-tsc"],
        ["MainThread node /x/.pnpm/vitest@4.0.9/node_modules/vitest/dist/workers/forks.js", "vitest"],
        ["MainThread node /work/intentic/_site/demo/node_modules/vite/bin/vite.js", "vite"],
        [
            "claude /history/engines/claude/versions/0.3.278/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --output-format stream-json",
            "claude",
        ],
        ["chrome /opt/google/chrome/google-chrome --headless", "chrome"],
        ["containerd-shim /usr/bin/containerd-shim-runc-v2", "containerd"],
        ["MainThread /usr/local/bin/node /opt/sandbox/dist/main.js", "node"],
        // `node_modules` is not the program node: `_` closes nothing.
        ["docservice /var/www/onlyoffice/documentserver/server/DocService/docservice", undefined],
    ] as const)("labels %s as %s", (command, program) => {
        expect(programOf(command)).toBe(program);
    });
});

describe("procfs units", () => {
    test("page size and clock rate come from the auxiliary vector, in either byte order", () => {
        const auxv = (littleEndian: boolean, pairs: readonly (readonly [number, number])[]): Buffer => {
            const buffer = Buffer.alloc(pairs.length * 16);
            const write = (value: number, offset: number): number =>
                littleEndian ? buffer.writeBigUInt64LE(BigInt(value), offset) : buffer.writeBigUInt64BE(BigInt(value), offset);
            pairs.forEach(([key, value], index) => {
                write(key, index * 16);
                write(value, index * 16 + 8);
            });
            return buffer;
        };
        expect(
            parseAuxv(
                auxv(true, [
                    [33, 5],
                    [6, 16_384],
                    [17, 250],
                    [0, 0],
                ]),
                true,
            ),
        ).toEqual({ pageBytes: 16_384, ticksPerSecond: 250 });
        expect(
            parseAuxv(
                auxv(false, [
                    [6, 65_536],
                    [17, 100],
                    [0, 0],
                ]),
                false,
            ),
        ).toEqual({ pageBytes: 65_536, ticksPerSecond: 100 });
        // A vector that names neither falls back to what every shipped platform uses, rather than to a zero divisor.
        expect(parseAuxv(Buffer.alloc(0), true)).toEqual({ pageBytes: 4096, ticksPerSecond: 100 });
    });
});
