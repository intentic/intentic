import { WORKSPACE_ROOT } from "@intentic/constants";
import { sessionsContract } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
import { routesClient } from "../harness/route-client.testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { type SessionsRoutesDeps, createSessionsRoutes } from "./sessions.routes.js";

// Drives the sessions routes over the two seams they read: the transcript store and the workspace root it is asked
// about.

const sessionsClient = (sessions: Partial<SessionsRoutesDeps["sessions"]>) =>
    routesClient(sessionsContract, createSessionsRoutes({ sessions: unstubbed("sessions", sessions), workspace: workspacePaths(WORKSPACE_ROOT) }));

test("sessions.list returns the full list, and routes to search when a query is given", async () => {
    const all = [{ id: "a", title: "Deploy pipeline", updatedAt: 2 }];
    const matches = [{ id: "b", title: "Auth bug", updatedAt: 1 }];
    const client = sessionsClient({ list: async () => all, search: async (query) => (query === "auth" ? matches : []) });

    expect(await client.list({})).toEqual({ sessions: all });
    expect(await client.list({ query: "auth" })).toEqual({ sessions: matches });
    expect(await client.list({ query: "   " })).toEqual({ sessions: all });
});

// Restores read from the workspace root, which reaches an isolated conversation's transcript too, since its turns ran
// in a linked worktree of the same repo.
test("sessions.get restores a transcript, and a session the store cannot read is NOT_FOUND", async () => {
    const read = vi.fn(async (dir: string, id: string) => {
        if (id !== "s1") {
            throw new Error("no such session");
        }
        return [
            { role: "assistant" as const, text: dir, tools: [{ id: "t1", name: "Read", category: "read" as const, status: "completed" as const }] },
        ];
    });
    const client = sessionsClient({ read });

    expect(await client.get({ id: "s1" })).toEqual({
        messages: [{ role: "assistant", text: "/work", tools: [{ id: "t1", name: "Read", category: "read", status: "completed" }] }],
    });
    await expect(client.get({ id: "gone" })).rejects.toThrow();
});
