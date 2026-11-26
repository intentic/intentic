import type { DeviceAgentFlow, DeviceFlowLine } from "@intentic/sandbox-contract/schemas/devices";
import type { DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import type { WslMemory, WslMemoryFit } from "@intentic/sandbox-contract/schemas/wsl-memory";
import { opt } from "../../opt.js";
import { wslMemoryApplied, wslMemoryNeed } from "./wsl-memory-need.js";

// A WSL memory card (2026-11-26): raised by the sandbox when the PC it runs on says its VM is too big, answered by a
// maintainer, whose yes runs the PC's `wsl-memory` op with the size the card shows. Nothing restarts.

const GIB = 1024 ** 3;
const PATH = "C:\\Users\\radar\\.wslconfig";
const FIT: WslMemoryFit = {
    at: 1,
    windowMs: 4 * 3_600_000,
    readings: 48,
    totalBytes: 31.4 * GIB,
    lowLineBytes: 3.14 * GIB,
    underLowShare: 0.875,
    availableMedianBytes: 2.6 * GIB,
    vmMedianBytes: 16.2 * GIB,
    outsideBytes: 12.5 * GIB,
    configuredGb: 22,
    proposedGb: 15,
    atFloor: false,
    text: "Windows was short.",
};

const factsWith = (memory: WslMemory | undefined, features: string[] = ["wsl-memory"]): DeviceFacts => ({
    os: "Windows 11 Home",
    arch: "x64",
    shell: "pwsh",
    home: "C:\\Users\\radar",
    roots: ["C:\\Users\\radar"],
    features,
    ...opt("wslMemory", memory),
});

const NEED: Need = {
    id: "need-1",
    conversationId: "conv-a",
    subject: { kind: "wsl-memory", device: "rog", configPath: PATH, fit: FIT },
    title: "rog's WSL VM is too big for it: memory=15GB would fit",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
};

interface Harness {
    readonly kind: ReturnType<typeof wslMemoryNeed>;
    readonly ran: { device: string; flow: DeviceAgentFlow }[];
    readonly state: { facts: DeviceFacts | undefined; online: boolean; frames: DeviceFlowLine[]; after: DeviceFacts | undefined; throws?: string };
}

const harness = (): Harness => {
    const ran: Harness["ran"] = [];
    const state: Harness["state"] = {
        facts: factsWith({ configPath: PATH, configuredGb: 22, fit: FIT }),
        online: true,
        frames: [
            { kind: "line", text: "Saved the file as it was to C:\\Users\\radar\\.wslconfig.bak.2026-11-26." },
            { kind: "line", text: "Set memory=15GB in C:\\Users\\radar\\.wslconfig, from 22GB." },
            { kind: "result", message: "memory= in this PC's .wslconfig was set." },
        ],
        after: factsWith({ configPath: PATH, configuredGb: 15 }),
    };
    const kind = wslMemoryNeed({
        facts: () => state.facts,
        online: () => state.online,
        async *runAgentFlow(device, flow) {
            ran.push({ device, flow });
            if (state.throws !== undefined) {
                throw new Error(state.throws);
            }
            yield* state.frames;
        },
        refresh: async () => {
            state.facts = state.after;
        },
    });
    return { kind, ran, state };
};

const approve = { kind: "approve" } as const;
const maintainer = { email: "owner@example.com", maintainer: true } as const;

describe("wslMemoryNeed", () => {
    it("runs the PC's wsl-memory op with the size the card shows, and says the VM keeps its size until WSL restarts", async () => {
        const { kind, ran } = harness();
        const answered = await kind.answer(NEED, approve, maintainer);
        expect(ran).toEqual([{ device: "rog", flow: { op: "wsl-memory", memoryGb: 15 } }]);
        expect(answered).toMatchObject({ status: "met" });
        const result = "result" in answered ? answered.result : "";
        expect(result).toContain("Set memory=15GB in C:\\Users\\radar\\.wslconfig, from 22GB.");
        expect(result).toContain("which restarts every sandbox there, this one included.");
    });

    it("refuses while the PC is away, and to an agent without the op, running nothing", async () => {
        const { kind, ran, state } = harness();
        state.online = false;
        expect(await kind.answer(NEED, approve, maintainer)).toEqual({ refused: "rog is not connected right now, so nothing can change its .wslconfig: press again once it is back." });
        state.online = true;
        state.facts = factsWith({ configPath: PATH, configuredGb: 22, fit: FIT }, ["power"]);
        expect(await kind.answer(NEED, approve, maintainer)).toEqual({ refused: "rog's agent is older than this: update it from the Devices view, then press again." });
        expect(ran).toEqual([]);
    });

    it("hands back the PC's own refusal", async () => {
        const { kind, state } = harness();
        state.frames = [{ kind: "error", message: "EPERM: .wslconfig is read-only" }];
        expect(await kind.answer(NEED, approve, maintainer)).toEqual({ refused: "EPERM: .wslconfig is read-only" });
        state.throws = "the link dropped";
        expect(await kind.answer(NEED, approve, maintainer)).toEqual({ refused: "the link dropped" });
    });

    it("a run cut off before it said it finished counts only when the fresh facts show the new size", async () => {
        const { kind, state } = harness();
        state.frames = [{ kind: "line", text: "Setting memory=15GB" }];
        state.after = factsWith({ configPath: PATH, configuredGb: 22, fit: FIT });
        expect(await kind.answer(NEED, approve, maintainer)).toEqual({ refused: "rog stopped answering before it said .wslconfig was written: press again once it is back." });
        state.after = factsWith({ configPath: PATH, configuredGb: 15 });
        expect(await kind.answer(NEED, approve, maintainer)).toMatchObject({ status: "met" });
    });

    it("is met by a .wslconfig set by hand at or under the size proposed", async () => {
        const { kind, state } = harness();
        expect(await kind.check(NEED)).toBeUndefined();
        state.facts = factsWith({ configPath: PATH, configuredGb: 14 });
        expect(await kind.check(NEED)).toEqual({
            result: "rog's .wslconfig gives the VM memory=14GB now. The VM keeps its old size until WSL restarts on rog (wsl --shutdown, or a reboot), which restarts every sandbox there, this one included.",
            use: [],
        });
        expect(wslMemoryApplied(NEED.subject.kind === "wsl-memory" ? NEED.subject : { fit: FIT }, factsWith(undefined))).toBe(false);
    });

    it("is a maintainer's to answer, one card per PC, and never the agent's", () => {
        const { kind } = harness();
        expect(kind.mayAnswer?.(NEED, { email: "guest@example.com" })).toBe("Only a sandbox maintainer, signed in, can change a connected PC's .wslconfig or dismiss this.");
        expect(kind.mayAnswer?.(NEED, maintainer)).toBeUndefined();
        expect(kind.key(NEED.subject)).toBe("rog");
        expect(kind.tellsAgent).toBe(false);
    });
});
