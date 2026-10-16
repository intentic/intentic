import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentRequest, MuseCredential } from "../../agent/providers/agent-request.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { createMuseAgent } from "./muse-agent.js";
import { museCli } from "./muse-cli.js";
import { spawnMuseHost } from "./muse-host.js";

// The real `muse serve`, where this machine has one (the engine store or PATH): one whole turn over the Muse Session
// Protocol on Muse's own offline `echo` provider, so no key and no network. Skipped where Muse Code is not installed.

const binary = await museCli();

test.skipIf(binary === undefined)("a turn runs end to end on the real Muse Code host", async () => {
    const home = mkdtempSync(join(tmpdir(), "muse-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "muse-ws-"));
    const spawn = spawnMuseHost();
    const agent = createMuseAgent({
        binary: async () => binary,
        // Muse's offline provider answers `echo: <prompt>`; an ephemeral host keeps nothing in the throwaway home.
        open: (launch) => spawn({ ...launch, args: [...launch.args, "--provider", "echo", "--no-session-log"], env: { ...launch.env, HOME: home } }),
    });
    const request: AgentRequest<MuseCredential> = {
        execution: unstubbed("execution", {}),
        spec: { prompt: "hello muse", cwd: workspace },
        policy: { permissionMode: "bypassPermissions" },
        tools: {},
        credential: { kind: "muse", apiKey: "unused-by-echo" },
        hooks: { cards: parkedCards(memoryFleet().conversations) },
        signal: new AbortController().signal,
    };
    const events: AgentEvent[] = [];
    for await (const event of agent(request)) {
        events.push(event);
    }
    expect(events.filter((event) => event.kind === "error")).toEqual([]);
    expect(events[0]).toMatchObject({ kind: "session", sessionId: expect.any(String) });
    expect(
        events
            .filter((event) => event.kind === "delta")
            .map((event) => event.text)
            .join(""),
    ).toBe("echo: hello muse");
    expect(events.at(-1)).toEqual({ kind: "done" });
}, 60_000);
