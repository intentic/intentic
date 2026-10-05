import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DeviceFacts, DevicePairing, LandingDelivery, ProjectDelivery, ProjectDeliveryResult, WorkspaceEvent } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import { isolatedAgent } from "../../../testing.js";
import type { PersistedAgent } from "../../registry/agents-store.js";
import {
    createProjectDelivery,
    type DeliveryClient,
    deliveryOf,
    type OwedDelivery,
    projectDeliveriesDocument,
    type ProjectDeliveryDeps,
} from "../project-delivery.js";

// A land into a folder attached to this computer's sandbox reaches the folder on the computer through its machine agent:
// what the land changed is read off git whole (binary-safe, links held back), the machine's merges come back into the
// sandbox's copy, and a computer that is away gets the land when it connects. The repository and the queue file are
// real; the machine is a stand-in answering `deliverProject` as it is told to.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> =>
    (await exec("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout.trim();

const PROJECT = "my-app";
const HOST = "ada-laptop";
const URL = "https://sandbox-abc123def456.intentic.dev";
const OURS = "sandbox-abc123def456-intentic-dev";
const FOLDER = "/home/ada/my-app";
// Bytes no text decoding survives: a NUL, a lone continuation byte, a high byte.
const BINARY_BEFORE = Buffer.from([0x00, 0x80, 0xff, 0x10]);
const BINARY_AFTER = Buffer.from([0x00, 0x80, 0xff, 0x11, 0xfe]);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const b64 = (text: string | Buffer): string => Buffer.from(text).toString("base64");

// A project repository with a start and a landed tip that between them add, modify, delete, make executable, change a
// binary file and move a link.
const repository = async (): Promise<{ base: string; work: string; dir: string; from: string; tip: string }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-delivery-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const dir = join(work, PROJECT);
    await mkdir(dir, { recursive: true });
    await sh(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "mod.txt"), "one\n");
    await writeFile(join(dir, "gone.txt"), "bye\n");
    await writeFile(join(dir, "run.sh"), "echo hi\n");
    await writeFile(join(dir, "bin.dat"), BINARY_BEFORE);
    await symlink("mod.txt", join(dir, "link"));
    await sh(dir, "add", "-A");
    await sh(dir, "commit", "-q", "-m", "from");
    const from = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "mod.txt"), "one\ntwo\n");
    await rm(join(dir, "gone.txt"));
    await writeFile(join(dir, "new.txt"), "fresh\n");
    await chmod(join(dir, "run.sh"), 0o755);
    await writeFile(join(dir, "bin.dat"), BINARY_AFTER);
    await rm(join(dir, "link"));
    await symlink("new.txt", join(dir, "link"));
    await sh(dir, "add", "-A");
    await sh(dir, "commit", "-q", "-m", "tip");
    const tip = await sh(dir, "rev-parse", "HEAD");
    return { base, work, dir, from, tip };
};

const FACTS: DeviceFacts = { os: "linux", arch: "x64", shell: "bash", home: "/home/ada", roots: ["/home/ada"], features: ["project-delivery"] };

const PAIRING: DevicePairing = { sandboxId: OURS, mode: "sync", localDir: FOLDER, remoteDir: `/work/${PROJECT}`, deliver: "auto" };

interface Machine {
    online: boolean;
    pairings: DevicePairing[] | undefined;
    answer: (input: ProjectDelivery) => Promise<ProjectDeliveryResult>;
    readonly asked: ProjectDelivery[];
}

const delivered = (folder = FOLDER): ProjectDeliveryResult => ({ point: "rp-1", folder, applied: [], merged: [], already: [], conflicts: [] });

// The daemon around delivery: one conversation whose landed tip the test sets, one machine, and what reached the card.
// `features` is what the machine's agent advertises, `maxBytes` the ceiling on one delivery.
const harness = (
    repo: { base: string; work: string },
    machine: Machine,
    { features = ["project-delivery"], maxBytes }: { readonly features?: string[]; readonly maxBytes?: number } = {},
) => {
    let entry: PersistedAgent = isolatedAgent([{ repo: PROJECT, base: "0".repeat(40) }]);
    const recorded: { id: string; delivery: LandingDelivery }[] = [];
    const treeChanged: string[] = [];
    const client: DeliveryClient = {
        deliverProject: async (input) => {
            machine.asked.push(input);
            return await machine.answer(input);
        },
    };
    const deps: ProjectDeliveryDeps = {
        agents: {
            entry: (id) => (id === entry.id ? entry : undefined),
            recordDelivery: async (id, delivery) => void recorded.push({ id, delivery }),
        },
        agentWorktrees: { mainDir: (name) => join(repo.work, name), withRepoLock: async (_repo, task) => await task() },
        events: {
            publish: (name, event) => {
                if (name === "tree.changed") {
                    // SAFETY: the name was just checked, and a "tree.changed" announcement carries its label.
                    treeChanged.push((event as { label: string }).label);
                }
            },
            subscribe: () => () => undefined,
        },
        hostHub: {
            known: () => [HOST],
            connected: () => (machine.online ? [HOST] : []),
            online: () => machine.online,
            state: () => ({ facts: { ...FACTS, features } }),
            client: () => (machine.online ? client : undefined),
        },
        logger: { info: () => undefined, warn: () => undefined },
        syncFleet: async () => ({ reports: [] }),
        historyRoot: join(repo.base, "history"),
        publicUrl: URL,
        platformId: undefined,
        pairingsOf: async () => machine.pairings,
    };
    const delivery = createProjectDelivery(deps, maxBytes === undefined ? {} : { maxBytes });
    const land = async (from: string, tip: string): Promise<void> => {
        entry = isolatedAgent([{ repo: PROJECT, base: from, landedTip: tip }]);
        const event: WorkspaceEvent = {
            event: "agent.landed",
            agentId: entry.id,
            title: "Count to two",
            branch: "agent/c1",
            outcome: "landed",
            repos: [{ repo: PROJECT, from, dir: "" }],
        };
        delivery.landed(event);
        await delivery.settled();
    };
    const queue = async (): Promise<OwedDelivery[]> => {
        const raw = await readFile(join(repo.base, "history", projectDeliveriesDocument.path), "utf8").catch(() => `{"queue":[]}`);
        // SAFETY: the file is the delivery's own, written through its document's schema.
        return (JSON.parse(raw) as { queue: OwedDelivery[] }).queue;
    };
    return { delivery, land, recorded, treeChanged, queue };
};

const machineAt = (overrides: Partial<Machine> = {}): Machine => ({
    online: true,
    pairings: [PAIRING],
    answer: async () => delivered(),
    asked: [],
    ...overrides,
});

test("a land's change is read off git whole: added, modified, deleted, executable and binary files, links held back", async () => {
    const { dir, from, tip } = await repository();
    const built = await deliveryOf(dir, from, tip);
    expect(built.tooLarge).toBe(false);
    const byPath = new Map(built.files.map((file) => [file.path, file]));
    expect([...byPath.keys()].toSorted()).toEqual(["bin.dat", "gone.txt", "mod.txt", "new.txt", "run.sh"]);
    expect(byPath.get("mod.txt")).toEqual({ path: "mod.txt", kind: "modified", base: b64("one\n"), next: b64("one\ntwo\n") });
    expect(byPath.get("gone.txt")).toEqual({ path: "gone.txt", kind: "deleted", base: b64("bye\n"), next: null });
    expect(byPath.get("new.txt")).toEqual({ path: "new.txt", kind: "added", base: null, next: b64("fresh\n") });
    expect(byPath.get("run.sh")).toEqual({ path: "run.sh", kind: "modified", base: b64("echo hi\n"), next: b64("echo hi\n"), executable: true });
    // Byte for byte, not through a text decoding.
    expect(Buffer.from(byPath.get("bin.dat")?.next ?? "", "base64")).toEqual(BINARY_AFTER);
    expect(Buffer.from(byPath.get("bin.dat")?.base ?? "", "base64")).toEqual(BINARY_BEFORE);
    // The folder decides what stands where a link is: nothing is sent, and the path is named.
    expect(built.kept).toEqual([{ path: "link", reason: "link" }]);
});

test("past the ceiling nothing is read whole and the delivery is too large", async () => {
    const { dir, from, tip } = await repository();
    expect(await deliveryOf(dir, from, tip, undefined, 8)).toEqual({ files: [], kept: [], tooLarge: true });
});

test("the machine's merges land in the sandbox's copy too, and the card says what was kept out", async () => {
    const repo = await repository();
    const machine = machineAt({
        answer: async () => ({
            point: "rp-7",
            folder: FOLDER,
            applied: ["new.txt", "gone.txt"],
            merged: [{ path: "mod.txt", content: b64("zero\none\ntwo\n") }],
            already: ["run.sh"],
            conflicts: [{ path: "bin.dat", reason: "edited" }],
        }),
    });
    const { land, recorded, treeChanged, queue } = harness(repo, machine);
    await land(repo.from, repo.tip);

    expect(machine.asked).toHaveLength(1);
    expect(machine.asked[0]?.remoteDir).toBe(`/work/${PROJECT}`);
    expect(machine.asked[0]?.landing).toEqual({ agentId: "c1", title: "Count to two" });
    expect(machine.asked[0]?.files.map((file) => file.path).toSorted()).toEqual(["bin.dat", "gone.txt", "mod.txt", "new.txt", "run.sh"]);
    // Both copies hold the merged bytes now.
    expect(await readFile(join(repo.dir, "mod.txt"), "utf8")).toBe("zero\none\ntwo\n");
    expect(treeChanged).toHaveLength(1);
    expect(recorded).toEqual([
        {
            id: "c1",
            delivery: {
                state: "partial",
                at: expect.any(Number),
                project: PROJECT,
                folder: FOLDER,
                applied: 3,
                conflicts: [
                    { path: "link", reason: "link" },
                    { path: "bin.dat", reason: "edited" },
                ],
                point: "rp-7",
            },
        },
    ]);
    expect(await queue()).toEqual([]);
});

test("a merge naming a path outside the folder, or into its .git, is not written here", async () => {
    const repo = await repository();
    const machine = machineAt({
        answer: async () => ({
            ...delivered(),
            merged: [
                { path: "../escape.txt", content: b64("no") },
                { path: ".git/config", content: b64("no") },
            ],
        }),
    });
    const { land, recorded, treeChanged } = harness(repo, machine);
    const config = await readFile(join(repo.dir, ".git", "config"), "utf8");
    await land(repo.from, repo.tip);
    await expect(readFile(join(repo.work, "escape.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(repo.dir, ".git", "config"), "utf8")).toBe(config);
    expect(treeChanged).toEqual([]);
    expect(recorded[0]?.delivery.state).toBe("partial");
});

test("everything written as landed reads as delivered, with the machine's restore point", async () => {
    const repo = await repository();
    const machine = machineAt({ answer: async () => ({ ...delivered(), applied: ["mod.txt", "new.txt", "gone.txt", "run.sh", "bin.dat"] }) });
    const { land, recorded } = harness(repo, machine);
    await land(repo.from, repo.tip);
    // The link is still named: nothing was sent for it.
    expect(recorded[0]?.delivery).toMatchObject({ state: "partial", applied: 5, point: "rp-1", conflicts: [{ path: "link", reason: "link" }] });

    // A land of plain files only reads as delivered.
    await writeFile(join(repo.dir, "mod.txt"), "three\n");
    await sh(repo.dir, "commit", "-q", "-am", "next");
    const next = await sh(repo.dir, "rev-parse", "HEAD");
    machine.answer = async () => ({ ...delivered(), applied: ["mod.txt"] });
    await land(repo.tip, next);
    expect(recorded[1]?.delivery).toEqual({
        state: "delivered",
        at: expect.any(Number),
        project: PROJECT,
        folder: FOLDER,
        applied: 1,
        conflicts: [],
        point: "rp-1",
    });
});

test("a computer that is away gets the land when it connects; until then the card says it waits", async () => {
    const repo = await repository();
    const machine = machineAt({ online: false });
    const { delivery, land, recorded, queue } = harness(repo, machine);
    await land(repo.from, repo.tip);

    expect(machine.asked).toEqual([]);
    expect(recorded.map(({ delivery: kept }) => kept.state)).toEqual(["waiting"]);
    expect(recorded[0]?.delivery).toMatchObject({ folder: FOLDER, applied: 0, reason: expect.stringContaining("not connected") });
    expect(await queue()).toEqual([
        { agentId: "c1", project: PROJECT, from: repo.from, tip: repo.tip, title: "Count to two", queuedAt: expect.any(Number) },
    ]);

    // Still away: nothing is said again.
    await delivery.retry();
    expect(recorded).toHaveLength(1);

    machine.online = true;
    await delivery.retry();
    expect(machine.asked).toHaveLength(1);
    expect(recorded.map(({ delivery: kept }) => kept.state)).toEqual(["waiting", "partial"]);
    expect(await queue()).toEqual([]);
});

test("a later land of the same conversation carries the one still waiting: one delivery from the first start", async () => {
    const repo = await repository();
    const machine = machineAt({ online: false });
    const { delivery, land, queue } = harness(repo, machine);
    await land(repo.from, repo.tip);
    await writeFile(join(repo.dir, "later.txt"), "later\n");
    await sh(repo.dir, "add", "-A");
    await sh(repo.dir, "commit", "-q", "-m", "later");
    const later = await sh(repo.dir, "rev-parse", "HEAD");
    await land(repo.tip, later);

    // One entry, from where the first land started to where the second one landed.
    expect(await queue()).toEqual([expect.objectContaining({ agentId: "c1", from: repo.from, tip: later })]);

    machine.online = true;
    await delivery.retry();
    expect(machine.asked).toHaveLength(1);
    expect(machine.asked[0]?.files.map((file) => file.path).toSorted()).toEqual(["bin.dat", "gone.txt", "later.txt", "mod.txt", "new.txt", "run.sh"]);
    expect(await queue()).toEqual([]);
});

test("a computer whose agent cannot deliver yet waits like one that is away", async () => {
    const repo = await repository();
    const machine = machineAt();
    // Connected, holding the folder, and advertising nothing it could be asked.
    const { land, recorded, queue } = harness(repo, machine, { features: [] });
    await land(repo.from, repo.tip);
    expect(machine.asked).toEqual([]);
    expect(recorded[0]?.delivery).toMatchObject({ state: "waiting", reason: expect.stringContaining("too old") });
    expect(await queue()).toHaveLength(1);
});

test("the folder's own machine refusing reads as failed, in its words, and nothing waits", async () => {
    const repo = await repository();
    const machine = machineAt({
        answer: async () => {
            throw new ORPCError("FORBIDDEN", { message: "That folder does not take deliveries." });
        },
    });
    const { land, recorded, queue } = harness(repo, machine);
    await land(repo.from, repo.tip);
    expect(recorded[0]?.delivery).toMatchObject({ state: "failed", reason: "That folder does not take deliveries.", folder: FOLDER });
    expect(await queue()).toEqual([]);
});

test("too large for one call: nothing is sent and the card sends the owner to Bring back", async () => {
    const repo = await repository();
    const machine = machineAt();
    const { land, recorded } = harness(repo, machine, { maxBytes: 8 });
    await land(repo.from, repo.tip);
    expect(machine.asked).toEqual([]);
    expect(recorded[0]?.delivery).toMatchObject({ state: "too-large", folder: FOLDER, applied: 0 });
});

test("a folder no machine holds for this sandbox is no delivery at all", async () => {
    const repo = await repository();
    const elsewhere = machineAt({ pairings: [{ ...PAIRING, sandboxId: "sandbox-999999999999-intentic-dev" }] });
    const other = harness(repo, elsewhere);
    await other.land(repo.from, repo.tip);
    expect(elsewhere.asked).toEqual([]);
    expect(other.recorded).toEqual([]);

    const manual = machineAt({ pairings: [{ ...PAIRING, deliver: "off" }] });
    const byHand = harness(repo, manual);
    await byHand.land(repo.from, repo.tip);
    expect(manual.asked).toEqual([]);
    expect(byHand.recorded).toEqual([]);
});

test("a waiting land whose folder was detached since says so instead of waiting for good", async () => {
    const repo = await repository();
    const machine = machineAt({ online: false });
    const { delivery, land, recorded, queue } = harness(repo, machine);
    await land(repo.from, repo.tip);
    // Back, and its report no longer lists the folder.
    machine.online = true;
    machine.pairings = [];
    await delivery.retry();
    expect(recorded.map(({ delivery: kept }) => kept.state)).toEqual(["waiting", "failed"]);
    expect(recorded[1]?.delivery.reason).toContain("no longer attached");
    expect(await queue()).toEqual([]);
});
