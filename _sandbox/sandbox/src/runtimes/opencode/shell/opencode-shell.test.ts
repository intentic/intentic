import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { z } from "zod";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { backgroundJobOf, settledBackgroundJobs } from "../../../agent/tools/jobs/background-jobs.js";
import { opt } from "../../../opt.js";
import { shellDoor, shellPaneOf, shellRouteOf } from "./opencode-shell.js";

// OpenCode's shell door as the script asks it, without the script: a pane command tmux-run returned still running is filed
// as a background job when the script says it is done, and the door answers the note the script prints after the output.
// 2026-11-02: 18 such returns in 8 OpenCode conversations told the agent only where the output was.

const actors = memoryFleet().conversations;
const PreparedSchema = z.object({ argv: z.array(z.string()), masked: z.boolean(), run: z.string().optional() });
const NoteSchema = z.object({ note: z.string().optional() });

const doorFor = (conversationId: string) => {
    const pane = shellPaneOf("ses_01JZ8Q4abcdefgh", [], conversationId);
    const route = shellRouteOf({ ...opt("pane", pane), jobs: { conversationId, profile: {}, conversations: actors } });
    return shellDoor((session) => (session === "ses_01JZ8Q4abcdefgh" ? route : undefined));
};

const prepare = async (door: ReturnType<typeof doorFor>, command: string) => {
    const plan = PreparedSchema.parse(await door["/prepare"].answer({ session: "ses_01JZ8Q4abcdefgh", command, cwd: WORKSPACE_ROOT }));
    return { ...plan, dir: dirname(plan.argv[plan.argv.indexOf("-f") + 1] ?? "") };
};

test("a pane command that came back still running is filed as a job, and the script is handed the note naming it", async () => {
    const door = doorFor("conv-opencode-overrun");
    const plan = await prepare(door, "cargo build --release");
    expect(readFileSync(join(plan.dir, "said"), "utf8")).toBe("cargo build --release");
    // A run the daemon must hear the end of, though nothing in it is masked.
    expect(plan.masked).toBe(false);
    // What tmux-run leaves for a command still running: its own files, and no status yet.
    writeFileSync(join(plan.dir, "cmd"), "cargo build --release\n");

    const { note = "" } = NoteSchema.parse(await door["/done"].answer({ run: plan.run ?? "" }));

    const id = /background job (\S+)\./u.exec(note)?.[1] ?? "";
    expect(backgroundJobOf(actors, "conv-opencode-overrun", id)?.dir).toBe(plan.dir);
    expect(note).toContain(`Wait for it with the \`wait\` tool (target "${id}")`);
    expect(settledBackgroundJobs(actors, "conv-opencode-overrun").running.map((job) => job.id)).toEqual([id]);
    rmSync(plan.dir, { recursive: true, force: true });
});

test("a pane command that finished, which tmux-run cleans up after, files nothing and adds nothing", async () => {
    const door = doorFor("conv-opencode-finished");
    const plan = await prepare(door, "ls");
    rmSync(plan.dir, { recursive: true, force: true });
    expect(await door["/done"].answer({ run: plan.run ?? "" })).toEqual({});
    expect(settledBackgroundJobs(actors, "conv-opencode-finished")).toEqual({ running: [], unseen: [] });
});
