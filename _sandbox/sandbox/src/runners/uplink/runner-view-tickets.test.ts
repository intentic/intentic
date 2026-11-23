import type { Caller } from "../../auth/auth.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { createRunnerViewTickets, mintRunnerViewTicket, type RunnerViewDeps, RunnerViewRefused, type RunnerViewRequest } from "./runner-view-tickets.js";

const maintainer: Caller = { email: "Maint@Example.test", tier: "maintainer" };
const writer: Caller = { email: "writer@example.test", tier: "writer" };

// A conversation placed on `runner`, or in the shared tree without one; `seal` makes it private to its readers.
// SAFETY: the ticket's checks read only a record's placement, identity, social and seal, which these carry.
const agent = (runner: string | undefined, seal?: object): PersistedAgent =>
    ({
        id: "c1",
        placement: runner === undefined ? { kind: "main" } : { kind: "worktree", runner, repos: [] },
        identity: {},
        social: {},
        seal,
    }) as never;

// `open`: the daemon runs without auth.
const depsOf = (entry: PersistedAgent | undefined, open = false): RunnerViewDeps => ({
    auth: open ? undefined : {},
    agents: { entry: (id) => (id === "c1" ? entry : undefined) },
});

const queryOf = (path: string): string => path.slice(path.indexOf("?") + 1);

describe("a runner view ticket", () => {
    test("opens exactly the view it was minted for, once, and names its member", () => {
        const tickets = createRunnerViewTickets();
        const minted = tickets.mint(depsOf(agent("r1")), { identity: maintainer, runner: "r1", conversationId: "c1", kind: "terminal", session: "agent-c1" });
        expect(minted.path).toBe(`/system/runner-view/r1/system/terminal?session=agent-c1&ticket=${minted.ticket}`);
        const question = { runner: "r1", path: "/system/terminal", query: queryOf(minted.path) };
        expect(tickets.redeem(question)).toEqual({ answer: "runnerView", allowed: true, member: "maint@example.test" });
        // One-shot.
        expect(tickets.redeem(question)).toMatchObject({ allowed: false });
    });

    test("is spent by a use that does not match, and matches only its runner, view and session", () => {
        const tickets = createRunnerViewTickets();
        const deps = depsOf(agent("r1"));
        const mint = () => tickets.mint(deps, { identity: maintainer, runner: "r1", conversationId: "c1", kind: "browser-view", session: "s1" });
        for (const wrong of [
            { runner: "r2", path: "/system/browser-view", query: (ticket: string) => `session=s1&ticket=${ticket}` },
            { runner: "r1", path: "/system/terminal", query: (ticket: string) => `session=s1&ticket=${ticket}` },
            { runner: "r1", path: "/system/browser-view", query: (ticket: string) => `session=s2&ticket=${ticket}` },
            { runner: "r1", path: "/workspace/raw", query: (ticket: string) => `session=s1&ticket=${ticket}` },
        ]) {
            const { ticket } = mint();
            expect(tickets.redeem({ runner: wrong.runner, path: wrong.path, query: wrong.query(ticket) })).toMatchObject({ allowed: false });
            if (wrong.path !== "/workspace/raw") {
                // The mismatch spent it: the right use after it finds nothing.
                expect(tickets.redeem({ runner: "r1", path: "/system/browser-view", query: `session=s1&ticket=${ticket}` })).toMatchObject({ allowed: false });
            }
        }
        expect(tickets.redeem({ runner: "r1", path: "/system/browser-view", query: "session=s1" })).toMatchObject({ allowed: false });
        expect(tickets.redeem({ runner: "r1", path: "/system/browser-view", query: "session=s1&ticket=forged" })).toMatchObject({ allowed: false });
    });

    test("binds a desktop view to its window, or the whole desktop", () => {
        const tickets = createRunnerViewTickets();
        const deps = depsOf(agent("r1"));
        const whole = tickets.mint(deps, { identity: maintainer, runner: "r1", conversationId: "c1", kind: "desktop-view", session: "" });
        expect(whole.path).toBe(`/system/runner-view/r1/system/desktop-view?ticket=${whole.ticket}`);
        expect(tickets.redeem({ runner: "r1", path: "/system/desktop-view", query: `media=1&ticket=${whole.ticket}` })).toMatchObject({ allowed: true });
        const one = tickets.mint(deps, { identity: maintainer, runner: "r1", conversationId: "c1", kind: "desktop-view", session: "w-1" });
        expect(tickets.redeem({ runner: "r1", path: "/system/desktop-view", query: `ticket=${one.ticket}` })).toMatchObject({ allowed: false });
    });

    test("expires", () => {
        let now = 0;
        const tickets = createRunnerViewTickets(() => now);
        const { path } = tickets.mint(depsOf(agent("r1")), { identity: maintainer, runner: "r1", conversationId: "c1", kind: "terminal", session: "t" });
        now = 30_001;
        expect(tickets.redeem({ runner: "r1", path: "/system/terminal", query: queryOf(path) })).toMatchObject({ allowed: false });
    });

    test("is minted only for a maintainer who may read the conversation that runner runs", () => {
        const tickets = createRunnerViewTickets();
        const request: Omit<RunnerViewRequest, "identity"> = { runner: "r1", conversationId: "c1", kind: "terminal", session: "agent-c1" };
        const refusedFor = (deps: RunnerViewDeps, identity: Caller | undefined, over: Partial<RunnerViewRequest> = {}): boolean => {
            try {
                tickets.mint(deps, { ...request, ...over, identity });
                return false;
            } catch (error) {
                expect(error).toBeInstanceOf(RunnerViewRefused);
                return true;
            }
        };
        expect(refusedFor(depsOf(agent("r1")), writer)).toBe(true);
        expect(refusedFor(depsOf(agent("r1")), undefined)).toBe(true);
        // Another runner's conversation, a local one, and one the registry does not know.
        expect(refusedFor(depsOf(agent("r2")), maintainer)).toBe(true);
        expect(refusedFor(depsOf(agent(undefined)), maintainer)).toBe(true);
        expect(refusedFor(depsOf(undefined), maintainer)).toBe(true);
        // A private conversation the maintainer is not a reader of.
        expect(refusedFor(depsOf(agent("r1", { readers: [{ email: "someone@example.test" }] })), maintainer)).toBe(true);
        // Names netd could not carry.
        expect(refusedFor(depsOf(agent("r1")), maintainer, { runner: "r/1" })).toBe(true);
        expect(refusedFor(depsOf(agent("r1")), maintainer, { session: "a&ticket=x" })).toBe(true);
        expect(refusedFor(depsOf(agent("r1")), maintainer, { session: "" })).toBe(true);
        // A daemon without auth: the owner's own tools mint, for no member.
        expect(refusedFor(depsOf(agent("r1"), true), undefined)).toBe(false);
    });

    test("is dropped by its member's revocation", () => {
        const tickets = createRunnerViewTickets();
        const deps = depsOf(agent("r1"));
        const { path } = tickets.mint(deps, { identity: maintainer, runner: "r1", conversationId: "c1", kind: "terminal", session: "t" });
        tickets.revoke("maint@example.test");
        expect(tickets.redeem({ runner: "r1", path: "/system/terminal", query: queryOf(path) })).toMatchObject({ allowed: false });
    });

    test("mints from a table of its own when none is named", () => {
        const minted = mintRunnerViewTicket(depsOf(agent("r1"), true), { identity: undefined, runner: "r1", conversationId: "c1", kind: "terminal", session: "t" });
        expect(minted.path).toContain("/system/runner-view/r1/system/terminal?session=t&ticket=");
    });
});
