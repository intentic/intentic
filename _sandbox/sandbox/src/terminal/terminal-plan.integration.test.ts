import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWsTickets } from "../auth/tokens/ws-tickets.js";
import { planTerminal, type TerminalPlanDeps } from "./terminal-plan.js";

// Node's whole say over a terminal the front serves: who may open it, and which session, directory or log it opens onto.

let root: string;
const warnings: string[] = [];

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "terminal-plan-"));
    mkdirSync(join(root, "app"));
    warnings.length = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (overrides: { readonly auth?: unknown; readonly logPathOf?: TerminalPlanDeps["logPathOf"] } = {}): TerminalPlanDeps => ({
    auth: "auth" in overrides ? overrides.auth : undefined,
    wsTickets: createWsTickets(),
    root,
    logPathOf: overrides.logPathOf ?? (() => undefined),
    warn: (_fields, message) => warnings.push(message),
});

test("a web tab creates or reattaches its session in the directory it asked for, inside the workspace only", () => {
    const opened = planTerminal(deps(), "session=web-1&cwd=app&cols=80");
    expect(opened).toEqual({ answer: "terminal", plan: { plan: "tmux", session: "web-1", argv: ["new-session", "-A", "-s", "web-1", "-c", join(root, "app")] } });
    for (const cwd of ["../etc", "missing", ""]) {
        expect(planTerminal(deps(), `session=web-1&cwd=${cwd}`).plan).toMatchObject({ argv: ["new-session", "-A", "-s", "web-1", "-c", root] });
    }
});

test("panel, agent and job sessions attach only, so a missing one ends rather than opening a bare shell", () => {
    for (const session of ["panel-web", "agent-abc", "job-checks"]) {
        expect(planTerminal(deps(), `session=${session}`).plan).toEqual({ plan: "tmux", session, argv: ["attach-session", "-t", `=${session}`] });
    }
});

test("a service's session is its log, and a service with no log ends at once", () => {
    const log = join(root, "api.log");
    const logPathOf = (key: string): string | undefined => (key === "api" ? log : undefined);
    expect(planTerminal(deps({ logPathOf }), "session=svc-api").plan).toEqual({ plan: "tail", path: log });
    expect(planTerminal(deps({ logPathOf }), "session=svc-gone").plan).toEqual({ plan: "exit", code: 0, reason: "no such service" });
});

test("a session name tmux could read as a flag is refused", () => {
    expect(planTerminal(deps(), "session=-C").plan).toEqual({ plan: "refused", code: 1008, reason: "invalid session" });
    expect(planTerminal(deps(), "").plan).toEqual({ plan: "refused", code: 1008, reason: "invalid session" });
});

test("with auth, a maintainer's ticket opens for that member, and anything less is refused and logged", () => {
    const withAuth = deps({ auth: {} });
    const ticket = withAuth.wsTickets.mint({ email: "Maintainer@Example.com", role: "maintainer" });
    expect(planTerminal(withAuth, `ticket=${ticket}&session=web-1`)).toMatchObject({ member: "maintainer@example.com", plan: { plan: "tmux" } });
    // Spent: the same ticket never opens a second socket.
    expect(planTerminal(withAuth, `ticket=${ticket}&session=web-1`).plan).toEqual({ plan: "refused", code: 1008, reason: "unauthorized" });
    const collaborator = withAuth.wsTickets.mint({ email: "c@example.com", role: "collaborator" });
    expect(planTerminal(withAuth, `ticket=${collaborator}&session=web-1`)).toEqual({
        answer: "terminal",
        plan: { plan: "refused", code: 1008, reason: "unauthorized" },
    });
    expect(warnings).toEqual(["terminal ticket rejected", "terminal ticket rejected"]);
});
