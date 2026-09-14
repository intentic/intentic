import { expect, test } from "vitest";
import { DOCKER_PANEL_KEY } from "../capabilities/handlers/docker.handler.js";
import { LOCAL_MODEL_PREFIX } from "../capabilities/handlers/localmodel.handler.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { SHELL } from "../terminal/pane-state.js";
import { panelState } from "./system.routes.js";

/* What the terminals list calls a `panel-*` session. Three unrelated things share the prefix, and the difference
 * matters to the tab strip: a dev server is a place the user keeps, while a run that ended is a record they open
 * once. Tmux cannot tell them apart, since both are a shell sitting at a prompt, so this asks the manager. */

// Stands in for the process manager: `tracked` is what it still holds, `runs` is what it knows was a one-shot.
const processes = (tracked: string[], runs: Record<string, { running: boolean; finishedAt?: number }> = {}): Pick<
    ManagedProcesses,
    "running" | "runOf"
> => ({
    running: (key) => tracked.includes(key),
    runOf: (key) => runs[key],
});

test("a repo's dev server is a panel, running for as long as the manager holds it", () => {
    expect(panelState(processes(["shop"]), "shop", "node")).toEqual({ kind: "panel", running: true });
    // Crashed: the manager let it go, and the pane it left behind is a stopped dev server, still its own tab.
    expect(panelState(processes([]), "shop", SHELL)).toEqual({ kind: "panel", running: false });
});

test("a one-shot run is a job, so the strip retires it the moment it finishes", () => {
    const running = processes(["root--verify"], { "root--verify": { running: true } });
    expect(panelState(running, "root--verify", "node")).toEqual({ kind: "job", running: true });

    // Untracked and back at a prompt: identical to the stopped dev server above, and told apart only by the run record.
    const done = processes([], { "root--verify": { running: false, finishedAt: 1_780_000_000_000 } });
    expect(panelState(done, "root--verify", SHELL)).toEqual({ kind: "job", running: false });
});

test("dockerd and local models stay processes: watched services, never a tab to type into", () => {
    expect(panelState(processes([DOCKER_PANEL_KEY]), DOCKER_PANEL_KEY, "dockerd")).toEqual({ kind: "process", running: true });
    // Tracked but back at its prompt, which for a service means it died: `running` is the command, not the session.
    expect(panelState(processes([DOCKER_PANEL_KEY]), DOCKER_PANEL_KEY, SHELL)).toEqual({ kind: "process", running: false });

    const model = `${LOCAL_MODEL_PREFIX}qwen`;
    expect(panelState(processes([model]), model, "llama-server")).toEqual({ kind: "process", running: true });
});
