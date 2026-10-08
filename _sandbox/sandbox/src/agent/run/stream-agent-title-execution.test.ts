import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { services as routeServices } from "../../harness/route-services.testing.js";
import * as titles from "../models/title-namer.js";
import * as transcripts from "../../sessions/turn-transcript.js";
import {
    agentInvocation, assertAgentExecutionContext, createAgentExecutionService,
    type AgentExecutionAdmission, type AgentExecutionContext, type AgentExecutionService,
} from "../../workload/agent-execution.js";

// The real conversation begin and stream admission execute. High-level title/index seams stop before composition,
// filesystem discovery or runtime launch. No namespace/process API is mocked and all stores are route-test memory.
const originalTitles = { ...titles };
const originalTranscripts = { ...transcripts };
interface TitleFixture {
    readonly title: (execution: AgentExecutionContext, conversationId: string, prompt: string) => Promise<void>;
    readonly index: () => never;
}
const fixtures = new Map<Services, TitleFixture>();
const fixtureOf = (services: Services): TitleFixture => {
    const fixture = fixtures.get(services);
    if (fixture === undefined) { throw new Error("unregistered pure title fixture"); }
    return fixture;
};
jest.mock("../models/title-namer.js", () => ({
    ...originalTitles,
    nameAgentTitle: (services: Services, execution: AgentExecutionContext, conversationId: string, prompt: string) =>
        fixtureOf(services).title(execution, conversationId, prompt),
}));
jest.mock("../../sessions/turn-transcript.js", () => ({
    ...originalTranscripts,
    turnStartIndex: (services: Services) => fixtureOf(services).index(),
}));
const { streamAgent } = await import("./stream-agent.js");
afterEach(() => fixtures.clear());
afterAll(() => {
    jest.mock("../models/title-namer.js", () => originalTitles);
    jest.mock("../../sessions/turn-transcript.js", () => originalTranscripts);
});

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};

test.each(["answer", "reject"] as const)("early title owns its issued context before composition and through detached %s after parent closure", async (ending) => {
    const issuer = createAgentExecutionService(async () => ({ agentDomain: "root" }));
    const lifecycle: string[] = [];
    const admissions: AgentExecutionAdmission[] = [];
    const contexts: AgentExecutionContext[] = [];
    const released = deferred<void>();
    const finishTitle = deferred<void>();
    const titleFinalized = deferred<void>();
    const failure = new Error("synthetic composition preflight failure");
    const titleFailure = new Error("synthetic title failure");
    const warnings: unknown[][] = [];
    const execution: AgentExecutionService = {
        admit: async () => { const admission = await issuer.admit(); admissions.push(admission); lifecycle.push("admit"); return admission; },
        acquire: (admission, placement) => {
            lifecycle.push("acquire-title");
            const lease = issuer.acquire(admission, placement);
            contexts.push(lease.context);
            return { context: lease.context, release: () => { lifecycle.push("release-title"); lease.release(); released.resolve(); } };
        },
        close: (admission) => { lifecycle.push("close-parent"); issuer.close(admission); },
        borrow: issuer.borrow,
    };
    const services = routeServices({
        agentExecution: execution,
        logger: unstubbed<Services["logger"]>("logger", { warn: (...args: unknown[]) => void warnings.push(args) }),
    });
    fixtures.set(services, {
        title: async (context, conversationId, prompt) => {
            lifecycle.push("title-start");
            expect(conversationId).toBe("pure-early-title");
            expect(prompt).toBe("name this synthetic conversation");
            expect(context).toBe(contexts[0]!);
            try {
                await finishTitle.promise;
                assertAgentExecutionContext(context);
                lifecycle.push("title-finalize");
                if (ending === "reject") { throw titleFailure; }
            } finally { titleFinalized.resolve(); }
        },
        index: () => {
            lifecycle.push("before-composition");
            expect(contexts).toHaveLength(1);
            expect(agentInvocation(contexts[0]!, "title-helper", [])).toEqual({ command: "title-helper", args: [], cwd: services.workspace.root });
            throw failure;
        },
    });
    try {
        const stream = streamAgent(services, { conversationId: "pure-early-title", prompt: "name this synthetic conversation", isolated: true }, undefined);
        await expect(stream.next()).rejects.toBe(failure);
        expect(lifecycle).toEqual(["admit", "acquire-title", "title-start", "before-composition", "close-parent"]);
        expect(() => assertAgentExecutionContext(contexts[0]!)).not.toThrow();
        expect(() => issuer.acquire(admissions[0]!, { localCwd: services.workspace.root })).toThrow("Agent execution admission is not registered or has been closed.");
        expect(warnings).toEqual([]);
        finishTitle.resolve();
        await titleFinalized.promise;
        await released.promise;
        // Observe the detached catch without sleeping or polling.
        await Promise.resolve();
        expect(lifecycle).toEqual(["admit", "acquire-title", "title-start", "before-composition", "close-parent", "title-finalize", "release-title"]);
        expect(() => assertAgentExecutionContext(contexts[0]!)).toThrow("Agent execution context is not registered or has been released.");
        expect(warnings).toEqual(ending === "reject" ? [[{ err: titleFailure }, "agents: title naming failed"]] : []);
    } finally { finishTitle.resolve(); }
});
