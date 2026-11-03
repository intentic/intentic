import { isLandConflict } from "@intentic/sandbox-contract/events/land-conflict";
import type { LandConflict } from "@intentic/sandbox-contract/schemas/agents";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { fakeTurns } from "../../../seams/turn-starter.testing.js";
import { conversationEntry } from "../../registry/agents-store.testing.js";
import { resolveConflictNow } from "./resolve-conflict.js";

const diverged: LandConflict[] = [{ repo: "root", clean: 2, mainBranch: "main", paths: [{ path: "src/app.ts", reason: "diverged" }] }];
const theirsOnly: LandConflict[] = [{ repo: "root", clean: 0, paths: [{ path: "notes.md", reason: "workspace" }] }];

const servicesFor = (home: boolean) => {
    const fake = fakeTurns();
    const services = unstubbed<Pick<Services, "agents" | "turns" | "logger">>("services", {
        agents: unstubbed<Services["agents"]>("agents", { entry: () => conversationEntry({ id: "home-1", identity: home ? { home: true } : {} }) }),
        turns: unstubbed<Services["turns"]>("turns", fake.turns),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
    });
    return { fake, services };
};

// A home's person only chats with it, and an auto-landing conversation's person pressed nothing: either clash goes
// back to the conversation as the sandbox's resolve turn, never to them.
describe("a land that clashed, handed back at once", () => {
    test("is handed back to the home as the sandbox's resolve turn", async () => {
        const { fake, services } = servicesFor(true);
        await resolveConflictNow(services, "home-1", diverged);
        expect(fake.started).toHaveLength(1);
        const [turn] = fake.started;
        expect(turn).toMatchObject({ conversationId: "home-1", errand: "land-conflict", speaker: { kind: "sandbox", source: "home-land" } });
        expect(isLandConflict(turn?.prompt ?? "")).toBe(true);
        expect(turn?.prompt).toContain("src/app.ts");
        expect(turn?.prompt).toContain("git rebase main");
    });

    test("asks nothing when only the person's own edits block it, which no rebase reaches", async () => {
        const { fake, services } = servicesFor(true);
        await resolveConflictNow(services, "home-1", theirsOnly);
        expect(fake.started).toHaveLength(0);
    });

    test("is handed to any other conversation its caller sends, as the auto-land's resolve turn", async () => {
        const { fake, services } = servicesFor(false);
        await resolveConflictNow(services, "home-1", diverged);
        expect(fake.started).toHaveLength(1);
        expect(fake.started[0]).toMatchObject({ errand: "land-conflict", speaker: { kind: "sandbox", source: "auto-land" } });
    });
});
