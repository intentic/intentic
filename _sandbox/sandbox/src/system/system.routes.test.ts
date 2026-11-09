import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { memoryPresentationStore } from "./presentation/presentation-store.testing.js";
import type { PresentationAnswer } from "./platform-client.js";
import { createPresentationMirror } from "./presentation/presentation-mirror.js";
import { DOCKER_PANEL_KEY, LOCAL_MODEL_PREFIX } from "../ports/panel-keys.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { SHELL } from "../terminal/pane-state.js";
import { createSystemRoutes, panelState } from "./system.routes.js";

/* What the terminals list calls a `panel-*` session. Three unrelated things share the prefix, and the difference
 * matters to the tab strip: a dev server is a place the user keeps, while a run that ended is a record they open
 * once. Tmux cannot tell them apart, since both are a shell sitting at a prompt, so this asks the manager. */

// Stands in for the process manager: `tracked` is what it still holds, `runs` is what it knows was a one-shot.
const processes = (
    tracked: string[],
    runs: Record<string, { running: boolean; finishedAt?: number }> = {},
): Pick<ManagedProcesses, "running" | "runOf"> => ({
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

/* The sandbox's copy of its name and logo (presentation-mirror.ts), as a client that reaches it while the platform is
 * down reads it. The wire carries a missing logo as null, and keeps the digest, which only the daemon compares. */

const signedIn: OrpcContext = {
    headers: new Headers(),
    method: "GET",
    url: "/system/presentation",
    identity: { email: "ada@example.com", role: "viewer", methods: ["google"] },
};
const heard = { name: "radarsu-intentic", digest: "1f2e", at: "2026-11-08T09:00:00.000Z" };

const presentationRoutes = (ask: () => Promise<PresentationAnswer | undefined>) =>
    createSystemRoutes(
        unstubbed<Services>("services", {
            presentation: createPresentationMirror({
                store: memoryPresentationStore(heard),
                ask,
                logger: { warn: () => {} },
                now: () => new Date("2026-11-09T12:00:00.000Z"),
            }),
        }),
    );

test("the presentation is the copy held, its missing logo null and its digest left out", async () => {
    const routes = presentationRoutes(async () => undefined);
    expect(await call(routes.presentation, undefined, { context: signedIn })).toEqual({
        presentation: { name: "radarsu-intentic", image: null, at: "2026-11-08T09:00:00.000Z" },
    });
});

test("a refresh the platform cannot answer answers the copy held, unrefreshed", async () => {
    const routes = presentationRoutes(async () => undefined);
    expect(await call(routes.presentationRefresh, undefined, { context: signedIn })).toEqual({
        presentation: { name: "radarsu-intentic", image: null, at: "2026-11-08T09:00:00.000Z" },
        refreshed: false,
    });
});

test("a refresh the platform answers keeps and answers the new name and logo", async () => {
    const logo = "data:image/webp;base64,AA==";
    const routes = presentationRoutes(async () => ({ name: "renamed", image: logo, digest: "9a8b" }));
    expect(await call(routes.presentationRefresh, undefined, { context: signedIn })).toEqual({
        presentation: { name: "renamed", image: logo, at: "2026-11-09T12:00:00.000Z" },
        refreshed: true,
    });
    expect(await call(routes.presentation, undefined, { context: signedIn })).toEqual({
        presentation: { name: "renamed", image: logo, at: "2026-11-09T12:00:00.000Z" },
    });
});

test("a refresh that hears there is no name and no logo answers none, refreshed", async () => {
    const routes = presentationRoutes(async () => ({ name: "", digest: "0000" }));
    expect(await call(routes.presentationRefresh, undefined, { context: signedIn })).toEqual({ presentation: null, refreshed: true });
});
