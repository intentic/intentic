// The overlay approval lifecycle end to end, over real files in a throwaway workspace: an agent asks for a tool in the
// chat, the owner answers on that card or on the Environment card, the sandbox is rebuilt, and the card has to end up
// where the image actually is. Each test is one path a person really takes, including the ones that used to strand a
// card ("approved" forever after a rebuild that carried it) or bring a file back nobody asked for (a draft thrown away
// in the Changes panel, rewritten ten minutes later).
//
// "A rebuild" here is what the runner does: build whatever overlay is on disk, stamp its hash on the new container,
// and start a daemon whose boot composes again. Nothing is mocked below the daemon's own modules: the composer, the
// needs service and kind, the drift sweep and the ledger are the real ones.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { Capability, EnvironmentDrift, Need, NeedTold } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { environmentSourcesOf } from "../environment-composers.js";
import { environmentNeed } from "../needs/kinds/environment-need.js";
import type { NeedKindHandler, NeedKinds } from "../needs/need-kinds.js";
import { createNeeds, type Needs } from "../needs/needs.js";
import { PROVIDER_MODULES } from "../runtimes/runtime-table.js";
import { memoryNeedsStore } from "../testing.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { createDriftSweep } from "./drift-sweep.js";
import {
    approveDraft,
    approvedPath,
    approveEnvironment,
    composeEnvironment,
    customPath,
    decideRuntimeInstall,
    draftsDir,
    proposalPath,
    proposeDraft,
    readEnvironment,
    rejectDraft,
    rejectEnvironment,
    removeFromEnvironment,
    toolStanding,
} from "./environment.js";
import { fileRuntimeInstallsStore } from "./runtime-installs.js";

// No base image bakes any pack here, whatever machine runs the suite.
process.env["INTENTIC_PACK_STAMPS_DIR"] = mkdtempSync(join(tmpdir(), "lifecycle-stamps-"));

const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const FFMPEG = `# ffmpeg, for screen recordings.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update && apt-get install -y --no-install-recommends ffmpeg`;
const RUST = `# Rust, for the desktop app.
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain 1.99.0`;
const BUN = `# Bun, pinned.
RUN curl -fsSL https://example.invalid/bun-1.4.2.zip -o /tmp/bun.zip && echo ok`;

const vpn: Capability = { id: "office", kind: "vpn", config: { provider: "wireguard", config: "[Interface]\nPrivateKey = P\n", autoConnect: "on" } };

interface World {
    readonly services: Services;
    // The runner's stamp on the running container, mutable as a rebuild changes it.
    readonly sandbox: Services["config"]["sandbox"];
    readonly capabilities: Capability[];
    readonly kind: NeedKindHandler;
    readonly needs: Needs;
    readonly told: { conversationId: string; prompt: string }[];
    readonly ledgerPath: string;
}

const world = (): World => {
    const capabilities: Capability[] = [];
    const sandbox: Services["config"]["sandbox"] = {
        profile: "container",
        port: 8787,
        host: "0.0.0.0",
        publicUrl: "",
        vm: false,
        grant: "",
        allowUnauthenticated: false,
        environmentHash: "",
        name: "intentic-sandbox-lifecycle",
        image: "",
        baseImage: "",
        channel: "",
        previousImage: "",
        definitionSeed: "",
        devRoot: undefined,
        prewarm: false,
        projectDir: "",
        projectsHost: false,
    };
    const ledgerPath = join(mkdtempSync(join(tmpdir(), "lifecycle-ledger-")), "runtime-installs.json");
    const services: Services = unstubbed<Services>("services", {
        environmentSources: environmentSourcesOf(() => services),
        providerModules: PROVIDER_MODULES,
        config: unstubbed<Services["config"]>("config", { sandbox, extensionsDir: EXTENSIONS_DIR, openaiApiKey: "" }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: mkdtempSync(join(tmpdir(), "lifecycle-")) }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile, write: writeWorkspaceFile, remove: removeWorkspacePath }),
        runtimeInstalls: fileRuntimeInstallsStore(ledgerPath),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined, info: () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        authRoot: mkdtempSync(join(tmpdir(), "lifecycle-auth-")),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
    });
    // Wired exactly as needs-slice.ts wires it.
    const kind = environmentNeed({
        propose: (tool, steps) => proposeDraft(services, tool, steps),
        approve: (tool) => approveDraft(services, tool),
        reject: (tool) => rejectDraft(services, tool),
        standing: (subject) => toolStanding(services, subject),
        composedHash: () => composeEnvironment(services),
    });
    const told: World["told"] = [];
    let next = 0;
    const needs = createNeeds({
        store: memoryNeedsStore(),
        kinds: { environment: kind } as unknown as NeedKinds,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        raisingConversation: (named) => named ?? "conv-1",
        standingOf: () => undefined,
        isLive: () => false,
        draw: () => undefined,
        show: () => undefined,
        notify: () => undefined,
        withdrawNotification: () => undefined,
        steer: async (conversationId, prompt) => {
            told.push({ conversationId, prompt });
            return true;
        },
        wake: async (conversationId, prompt): Promise<NeedTold> => {
            told.push({ conversationId, prompt });
            return "queued";
        },
        continueWhenMet: async () => true,
        provideSecret: async () => ({ result: "", use: [] }),
        onTurnEnded: () => () => undefined,
        pollMs: 60_000,
        newId: () => `need-${(next += 1)}`,
    });
    return { services, sandbox, capabilities, kind, needs, told, ledgerPath };
};

// An agent's `environment propose <tool>`: the draft on the main tree and a card in its chat.
const ask = async (w: World, tool: string, steps: string, conversationId = "conv-1"): Promise<Need> => {
    const raised = await w.needs.ask({ raise: { ask: { kind: "environment", tool, steps }, wait: 0 }, conversationId, signal: new AbortController().signal });
    const need = "need" in raised ? raised.need : undefined;
    if (need === undefined) {
        throw new Error(`the ask for ${tool} raised nothing: ${JSON.stringify(raised)}`);
    }
    return need;
};

const approveCard = (w: World, need: Need): Promise<Need> => w.needs.answer(need.id, { kind: "approve" }, { email: "owner@acme.dev" });

// What the runner does: builds the overlay on disk (or the one handed in), stamps its hash, and the new daemon's boot
// composes again.
const rebuild = async (w: World, built?: string): Promise<void> => {
    const overlay = built ?? (await w.services.files.read(approvedPath(w.services)));
    if (overlay === undefined) {
        throw new Error("nothing to build");
    }
    (w.sandbox as { environmentHash: string }).environmentHash = sha256Hex(overlay);
    await w.services.files.write(approvedPath(w.services), overlay);
    await composeEnvironment(w.services);
};

// The needs service's own periodic check, run now and waited on: every card's status as it then stands.
const statuses = async (w: World, ids: readonly string[]): Promise<string[]> => {
    w.needs.recheck();
    const deadline = Date.now() + 2_000;
    let last: string[] = [];
    // The check runs in the background; wait until a second look agrees with the first.
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const now = await Promise.all(ids.map(async (id) => (await w.needs.get(id))?.status ?? "missing"));
        if (now.join(",") === last.join(",")) {
            return now;
        }
        last = now;
    }
    return last;
};

describe("a tool asked for in the chat ends where the image is", () => {
    // The failure the owner hit: three cards approved, one rebuild, and only the last one ever met, because each was
    // compared with the overlay composed by its own approval while the rebuild built the final one.
    test("three tools approved one after another and then one rebuild: every card is met", async () => {
        const w = world();
        const cards = [await ask(w, "ffmpeg", FFMPEG), await ask(w, "rust-tauri", RUST), await ask(w, "bun", BUN)];
        for (const card of cards) {
            expect((await approveCard(w, card)).status).toBe("working");
        }
        expect(await statuses(w, cards.map((card) => card.id))).toEqual(["working", "working", "working"]);
        await rebuild(w);
        expect(await statuses(w, cards.map((card) => card.id))).toEqual(["met", "met", "met"]);
        expect(w.told.map((entry) => entry.prompt).filter((prompt) => prompt.includes("is in the sandbox image now"))).toHaveLength(3);
    });

    test("a tool approved after a rebuild waits for the next one, and the cards already met stay met", async () => {
        const w = world();
        const first = await ask(w, "ffmpeg", FFMPEG);
        await approveCard(w, first);
        await rebuild(w);
        const second = await ask(w, "bun", BUN);
        await approveCard(w, second);
        expect(await statuses(w, [first.id, second.id])).toEqual(["met", "working"]);
        await rebuild(w);
        expect(await statuses(w, [first.id, second.id])).toEqual(["met", "met"]);
    });

    test("a rebuild from an overlay composed before the approval does not meet it", async () => {
        const w = world();
        const early = await ask(w, "ffmpeg", FFMPEG);
        await approveCard(w, early);
        const beforeBun = await w.services.files.read(approvedPath(w.services));
        const late = await ask(w, "bun", BUN);
        await approveCard(w, late);
        await rebuild(w, beforeBun);
        expect(await statuses(w, [early.id, late.id])).toEqual(["met", "working"]);
    });

    // Every capability change and every daemon update composes again; the rebuild builds whatever is newest.
    test("a capability changing the overlay between the approval and the rebuild still meets the card", async () => {
        const w = world();
        const card = await ask(w, "ffmpeg", FFMPEG);
        await approveCard(w, card);
        w.capabilities.push(vpn);
        await composeEnvironment(w.services);
        await rebuild(w);
        expect(await statuses(w, [card.id])).toEqual(["met"]);
    });

    test("a revision of the tool approved before the rebuild still meets the tool's first card", async () => {
        const w = world();
        const card = await ask(w, "ffmpeg", FFMPEG);
        await approveCard(w, card);
        expect(await proposeDraft(w.services, "ffmpeg", `${FFMPEG} libavcodec-extra`)).toEqual({ file: "ffmpeg.Dockerfile" });
        expect(await approveDraft(w.services, "ffmpeg")).toHaveProperty("hash");
        await rebuild(w);
        expect(await statuses(w, [card.id])).toEqual(["met"]);
    });

    // A container built by a daemon that kept no record of what it composed (every sandbox, the first time this ships):
    // the overlay it was built from is still on disk at the first boot, and is read there.
    test("a container built from an overlay nobody recorded is read at its first boot, and meets its cards", async () => {
        const w = world();
        const cards = [await ask(w, "ffmpeg", FFMPEG), await ask(w, "bun", BUN)];
        for (const card of cards) {
            await approveCard(w, card);
        }
        const ledger = JSON.parse((await readWorkspaceFile(w.ledgerPath)) ?? "{}") as Record<string, unknown>;
        delete ledger["compositions"];
        await writeWorkspaceFile(w.ledgerPath, JSON.stringify(ledger));
        await rebuild(w);
        expect(await statuses(w, cards.map((card) => card.id))).toEqual(["met", "met"]);
    });
});

describe("a card answered somewhere else follows the answer", () => {
    test("Approve all on the Environment card: the chat's Approve catches up instead of refusing, and the rebuild meets it", async () => {
        const w = world();
        const cards = [await ask(w, "ffmpeg", FFMPEG), await ask(w, "bun", BUN)];
        const { proposal } = await readEnvironment(w.services);
        expect(await approveEnvironment(w.services, proposal?.hash ?? "")).toBeUndefined();
        expect(await statuses(w, cards.map((card) => card.id))).toEqual(["open", "open"]);
        // Pressed afterwards: there is no draft left to approve, and that is not an error.
        expect((await approveCard(w, cards[0]!)).status).toBe("working");
        await rebuild(w);
        expect(await statuses(w, cards.map((card) => card.id))).toEqual(["met", "met"]);
    });

    test("one tool rejected on the Environment card: its chat card is declined, the other stays", async () => {
        const w = world();
        const [ffmpeg, bun] = [await ask(w, "ffmpeg", FFMPEG), await ask(w, "bun", BUN)];
        await rejectDraft(w.services, "ffmpeg");
        expect(await statuses(w, [ffmpeg!.id, bun!.id])).toEqual(["declined", "open"]);
        expect(w.told.some((entry) => entry.prompt.includes("ffmpeg was turned down or taken out"))).toBe(true);
    });

    test("Reject all on the Environment card declines every card it answered", async () => {
        const w = world();
        const cards = [await ask(w, "ffmpeg", FFMPEG), await ask(w, "bun", BUN)];
        await rejectEnvironment(w.services);
        expect(await statuses(w, cards.map((card) => card.id))).toEqual(["declined", "declined"]);
    });

    test("an approved tool taken out before the rebuild: its card is declined, not left waiting for a rebuild", async () => {
        const w = world();
        const card = await ask(w, "ffmpeg", FFMPEG);
        await approveCard(w, card);
        expect(await removeFromEnvironment(w.services, "ffmpeg")).toBeUndefined();
        expect(await statuses(w, [card.id])).toEqual(["declined"]);
    });

    test("a draft thrown away by hand (the Changes panel's discard): its card is declined", async () => {
        const w = world();
        const card = await ask(w, "ffmpeg", FFMPEG);
        await w.services.files.remove(join(draftsDir(w.services), "ffmpeg.Dockerfile"));
        expect(await statuses(w, [card.id])).toEqual(["declined"]);
    });

    test("a tool already built when its card is first answered is met at once", async () => {
        const w = world();
        const card = await ask(w, "ffmpeg", FFMPEG);
        const { proposal } = await readEnvironment(w.services);
        await approveEnvironment(w.services, proposal?.hash ?? "");
        await rebuild(w);
        // Raced with the check: whichever reaches the card first, it ends met.
        const answered = await approveCard(w, card).catch(async () => (await w.needs.get(card.id))!);
        expect(answered.status).toBe("met");
    });
});

describe("approving leaves nothing behind in the owner's Changes", () => {
    test("every card approved one at a time: no drafts and no proposal file", async () => {
        const w = world();
        for (const card of [await ask(w, "ffmpeg", FFMPEG), await ask(w, "bun", BUN)]) {
            await approveCard(w, card);
        }
        expect(await readWorkspaceFile(proposalPath(w.services))).toBeUndefined();
        expect(await readWorkspaceFile(join(draftsDir(w.services), "ffmpeg.Dockerfile"))).toBeUndefined();
        expect((await readEnvironment(w.services)).proposal).toBeUndefined();
    });

    test("Approve all: no proposal file left as a copy of what was just approved", async () => {
        const w = world();
        await ask(w, "ffmpeg", FFMPEG);
        const { proposal } = await readEnvironment(w.services);
        await approveEnvironment(w.services, proposal?.hash ?? "");
        expect(await readWorkspaceFile(proposalPath(w.services))).toBeUndefined();
    });

    // What an approval made before this fix left on disk, or a land brought back: read once, and gone.
    test("a leftover proposal identical to the approved section is cleared the next time the card is read", async () => {
        const w = world();
        await w.services.files.write(customPath(w.services), `# ---- ffmpeg ----\n${FFMPEG}\n`);
        await w.services.files.write(proposalPath(w.services), `# ---- ffmpeg ----\n${FFMPEG}\n`);
        expect((await readEnvironment(w.services)).proposal).toBeUndefined();
        expect(await readWorkspaceFile(proposalPath(w.services))).toBeUndefined();
    });
});

// The daemon's own drafts: a recurring runtime install (the sweep corroborates apt installs against the drift
// snapshot), and a cache-rule revision of an approved block.
describe("a draft the daemon wrote and the owner threw away stays thrown away", () => {
    const DRIFT: EnvironmentDrift = { bornAt: 0, at: 0, apt: ["p7zip-full"], paths: [] };
    const AUTO = join(".intentic", "config", "environment.d", "p7zip-full.Dockerfile");

    // Two sessions installing it at runtime is what earns an auto-draft.
    const recurring = async (w: World): Promise<void> => {
        for (const session of ["s1", "s2"]) {
            await w.services.runtimeInstalls.record([{ kind: "apt", tool: "p7zip-full" }], "apt-get install -y p7zip-full", session, 1_000);
        }
    };
    const sweep = (w: World) =>
        createDriftSweep({
            workspace: w.services.workspace,
            runtimeInstalls: w.services.runtimeInstalls,
            conversations: { liveSessionIds: () => [] },
            logger: { info: () => undefined, warn: () => undefined } as never,
            probe: async () => DRIFT,
        });
    const draftOnDisk = (w: World): Promise<string | undefined> => readWorkspaceFile(join(w.services.workspace.root, AUTO));

    test("an auto-draft discarded with its proposal is read as a no: declined, and neither file comes back", async () => {
        const w = world();
        await recurring(w);
        await sweep(w).refresh();
        expect(await draftOnDisk(w)).toContain("p7zip-full");
        expect((await readEnvironment(w.services)).proposal?.content).toContain("p7zip-full");
        // The Changes panel's discard: both files gone, nothing on any card.
        await w.services.files.remove(join(w.services.workspace.root, AUTO));
        await w.services.files.remove(proposalPath(w.services));
        await sweep(w).refresh();
        await sweep(w).refresh();
        expect(await draftOnDisk(w)).toBeUndefined();
        expect((await readEnvironment(w.services)).proposal).toBeUndefined();
        const ledger = await w.services.runtimeInstalls.read();
        expect(ledger.installs.find((entry) => entry.tool === "p7zip-full")?.declinedAt).toEqual(expect.any(Number));
        expect(ledger.offered ?? []).toEqual([]);
    });

    test("discarding only the draft takes its block out of the proposal still standing", async () => {
        const w = world();
        await recurring(w);
        await proposeDraft(w.services, "bun", BUN);
        await sweep(w).refresh();
        await readEnvironment(w.services);
        await w.services.files.remove(join(w.services.workspace.root, AUTO));
        await sweep(w).refresh();
        const { proposal } = await readEnvironment(w.services);
        expect(proposal?.content).toContain("# ---- bun ----");
        expect(proposal?.content).not.toContain("p7zip-full");
    });

    // Rejecting it one at a time used to only settle it: the sweep wrote it again, the next read deleted it as
    // answered, and the file flickered in the owner's Changes every ten minutes.
    test("an auto-draft rejected from its own Reject is not drafted again", async () => {
        const w = world();
        await recurring(w);
        await sweep(w).refresh();
        await rejectDraft(w.services, "p7zip-full");
        await sweep(w).refresh();
        expect(await draftOnDisk(w)).toBeUndefined();
        expect((await w.services.runtimeInstalls.read()).installs[0]?.declinedAt).toEqual(expect.any(Number));
    });

    test("an approved auto-draft is forgotten as an offer, never declined", async () => {
        const w = world();
        await recurring(w);
        await sweep(w).refresh();
        await approveDraft(w.services, "p7zip-full");
        await sweep(w).refresh();
        const ledger = await w.services.runtimeInstalls.read();
        expect(ledger.offered ?? []).toEqual([]);
        expect(ledger.installs[0]?.declinedAt).toBeUndefined();
        expect(await readWorkspaceFile(customPath(w.services))).toContain("# ---- p7zip-full ----");
    });

    test("an offered draft somebody rewrote is theirs: kept as written, forgotten as an offer, not declined", async () => {
        const w = world();
        await recurring(w);
        await sweep(w).refresh();
        await w.services.files.write(join(w.services.workspace.root, AUTO), "RUN apt-get install -y p7zip-full p7zip-rar\n");
        await sweep(w).refresh();
        expect(await draftOnDisk(w)).toBe("RUN apt-get install -y p7zip-full p7zip-rar\n");
        const ledger = await w.services.runtimeInstalls.read();
        expect(ledger.offered ?? []).toEqual([]);
        expect(ledger.installs[0]?.declinedAt).toBeUndefined();
    });

    test("dismissed then restored on the card: the sweep may draft it again, and it is not deleted as answered", async () => {
        const w = world();
        await recurring(w);
        await sweep(w).refresh();
        await decideRuntimeInstall(w.services, { tool: "p7zip-full", decision: "dismiss" });
        await sweep(w).refresh();
        expect(await draftOnDisk(w)).toBeUndefined();
        await decideRuntimeInstall(w.services, { tool: "p7zip-full", decision: "restore" });
        await sweep(w).refresh();
        expect((await readEnvironment(w.services)).proposal?.content).toContain("p7zip-full");
        expect(await draftOnDisk(w)).toContain("p7zip-full");
    });

    test("a draft adopted on the owner's say-so and then thrown away is read as a no too", async () => {
        const w = world();
        await w.services.runtimeInstalls.record([{ kind: "apt", tool: "p7zip-full" }], "apt-get install -y p7zip-full", "s1", 1_000);
        expect(await decideRuntimeInstall(w.services, { tool: "p7zip-full", decision: "adopt" })).toBeUndefined();
        await w.services.files.remove(join(w.services.workspace.root, AUTO));
        await sweep(w).refresh();
        expect((await w.services.runtimeInstalls.read()).installs[0]?.declinedAt).toEqual(expect.any(Number));
    });

    const LEGACY = "# ffmpeg\nRUN apt-get update \\\n    && apt-get install -y --no-install-recommends ffmpeg \\\n    && rm -rf /var/lib/apt/lists/*";
    const REVISION = join(".intentic", "config", "environment.d", "ffmpeg.Dockerfile");

    test("a cache-rule revision thrown away is not offered again; an approved one leaves nothing to revise", async () => {
        const thrown = world();
        await thrown.services.files.write(customPath(thrown.services), `# ---- ffmpeg ----\n${LEGACY}\n`);
        await sweep(thrown).refresh();
        expect(await readWorkspaceFile(join(thrown.services.workspace.root, REVISION))).toContain("--mount=type=cache,target=/var/lib/apt/lists");
        await thrown.services.files.remove(join(thrown.services.workspace.root, REVISION));
        await sweep(thrown).refresh();
        await sweep(thrown).refresh();
        expect(await readWorkspaceFile(join(thrown.services.workspace.root, REVISION))).toBeUndefined();

        const taken = world();
        await taken.services.files.write(customPath(taken.services), `# ---- ffmpeg ----\n${LEGACY}\n`);
        await sweep(taken).refresh();
        expect(await approveDraft(taken.services, "ffmpeg")).toHaveProperty("hash");
        await sweep(taken).refresh();
        expect(await readWorkspaceFile(join(taken.services.workspace.root, REVISION))).toBeUndefined();
        expect(await readWorkspaceFile(customPath(taken.services))).not.toContain("rm -rf /var/lib/apt/lists");
    });
});
