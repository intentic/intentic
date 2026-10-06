import { AGENTS_DOCKER_HOST, DOCKER_PRUNES, dockerPruneChore, reclaimedSpace, shouldPruneDocker } from "./docker-prune.js";
import { DOCKER_PANEL_KEY } from "../../ports/panel-keys.js";

const DAY_MS = 24 * 60 * 60_000;

test("a prune runs only while no turn does and the agents' dockerd is running", () => {
    expect(shouldPruneDocker(0, true)).toBe(true);
    expect(shouldPruneDocker(1, true)).toBe(false);
    expect(shouldPruneDocker(0, false)).toBe(false);
});

test("stopped containers past a day and dangling images past three days, never a tagged image, volume or network", () => {
    expect(DOCKER_PRUNES).toEqual([
        { what: "containers", args: ["container", "prune", "--force", "--filter", "until=24h"] },
        { what: "images", args: ["image", "prune", "--force", "--filter", "until=72h"] },
    ]);
    for (const { args } of DOCKER_PRUNES) {
        expect(args).not.toContain("--all");
        expect(args).not.toContain("-a");
        expect(args).not.toContain("--volumes");
    }
});

test("what docker reclaimed is read off its own summary line", () => {
    expect(reclaimedSpace("Deleted Images:\ndeleted: sha256:4f2e\n\nTotal reclaimed space: 1.204GB\n")).toBe("1.204GB");
    expect(reclaimedSpace("Total reclaimed space: 0B")).toBe("0B");
    expect(reclaimedSpace("")).toBeUndefined();
});

test("the chore is held by a live turn or a stopped engine, and prunes both through the agents' own engine", async () => {
    let live: string[] = ["calm-vale-gbmd"];
    let running = true;
    const asked: string[] = [];
    const calls: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const logged: unknown[] = [];
    const chore = dockerPruneChore({
        processes: {
            running: (key) => {
                asked.push(key);
                return running;
            },
        },
        conversations: { liveSessionIds: () => live },
        logger: { info: (fields: unknown) => logged.push(fields), warn: (fields: unknown) => logged.push(fields) },
        exec: async (command, args, options) => {
            expect(command).toBe("docker");
            calls.push({ args, env: options.env });
            if (args[0] === "image") {
                throw new Error("Cannot connect to the Docker daemon");
            }
            return { stdout: "Deleted Containers:\n9f1c\n\nTotal reclaimed space: 12.5MB\n" };
        },
    });
    expect(chore.name).toBe("docker-prune");
    expect(chore.everyMs).toBe(DAY_MS);
    expect(chore.when?.()).toBe(false);
    live = [];
    running = false;
    expect(chore.when?.()).toBe(false);
    running = true;
    expect(chore.when?.()).toBe(true);
    expect(new Set(asked)).toEqual(new Set([DOCKER_PANEL_KEY]));

    await chore.run();
    expect(calls.map((call) => call.args[0])).toEqual(["container", "image"]);
    expect(calls.every((call) => call.env["DOCKER_HOST"] === AGENTS_DOCKER_HOST)).toBe(true);
    // One prune failing does not keep the other from running, and each says what it did.
    expect(logged).toEqual([{ what: "containers", reclaimed: "12.5MB" }, expect.objectContaining({ what: "images" })]);
});
