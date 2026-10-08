import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isConversationId } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { hostsDir } from "../../capabilities/ssh-hosts.js";
import { opt } from "../../opt.js";
import { openPaneDoor } from "../../terminal/pane-door.js";
import { startAgentDomain } from "../../workload/domain/agent-domain.js";
import { AGENT_RUN, prepareAgentDomainView } from "../../workload/domain/agent-domain-view.js";
import { daemonGitConfig, provisionAgentHome } from "../../workload/domain/agent-home.js";
import { gitPointersIn, type IsolationAnchor, type IsolationPlan } from "./isolation.js";

// A TURN'S PLACE IN THE UNPRIVILEGED AGENT DOMAIN. What startAnchor is for a root-mode turn: one call that hands back an
// anchor every runtime and pane joins, here a domain (workload/domain/agent-domain.ts) over its view (agent-domain-view.ts), with
// the pane door its Bash panes are opened through (terminal/pane-door.ts) and the run directory it shares with the daemon.
// An isolated turn's plan makes /work its worktree; a main-tree turn's plan is the workspace itself, so every turn of a
// sandbox in unprivileged mode runs inside a domain, whichever placement its conversation has.

// One run directory per conversation, so what a turn leaves in /tmp is there for its next turn, as the container's /tmp
// was, and a background job's dir outlives the domain that started it until the daemon has read it. A turn with no
// conversation gets one of its own, removed with its domain. Forgotten with the conversation (forgetRunDir).
export const runDirOf = (historyRoot: string, conversationId: string | undefined): { readonly dir: string; readonly own: boolean } =>
    conversationId !== undefined && isConversationId(conversationId)
        ? { dir: join(historyRoot, AGENT_RUN, `c-${conversationId}`), own: false }
        : { dir: join(historyRoot, AGENT_RUN, `turn-${randomBytes(6).toString("hex")}`), own: true };

// A purged conversation's run directory goes with it. A domain still running for it keeps its own files open until it
// ends, as any process does with an unlinked tree. A failure is logged: nothing waits on a purge's side effects.
export const forgetRunDir = async (historyRoot: string, conversationId: string, logger: Pick<Logger, "warn">): Promise<void> => {
    if (!isConversationId(conversationId)) {
        return;
    }
    try {
        await rm(runDirOf(historyRoot, conversationId).dir, { recursive: true, force: true });
    } catch (error) {
        logger.warn({ err: error, conversationId }, "agent domain: removing the run directory failed");
    }
};

export interface DomainAnchorOptions {
    readonly plan: IsolationPlan;
    readonly historyRoot: string;
    readonly authRoot: string;
    readonly conversationId: string | undefined;
    // The conversation's ssh agent socket, when it has one (capabilities/turn-env.ts): bound into the domain at its path.
    readonly sshSocket: string | undefined;
    readonly logger: Pick<Logger, "warn">;
}

// The door listens before the view is prepared, because the view binds its socket; it answers nothing until the domain
// exists. Everything the domain holds (the door, the view's staging, a turn-owned run directory) is let go when the
// domain's namespace ends, not when the turn does: a released turn's background jobs keep it alive (agent-domain.ts).
export const startDomainAnchor = async (options: DomainAnchorOptions): Promise<IsolationAnchor> => {
    const { plan, historyRoot } = options;
    const run = runDirOf(historyRoot, options.conversationId);
    // The HOME every domain shares, made ready as the daemon's own is for a root-mode turn (agent-home.ts): its git
    // identity, its machines' public halves and the session store's links, read fresh so a change shows next turn.
    const home = join(historyRoot, "agent-home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    provisionAgentHome({ home, workspaceRoot: plan.root, gitconfig: await daemonGitConfig(), sshHosts: hostsDir() });
    const door = await openPaneDoor({ owner: options.conversationId, logger: options.logger });
    const release = async (cleanup: () => Promise<void>): Promise<void> => {
        const results = await Promise.allSettled([cleanup(), door.close(), ...(run.own ? [rm(run.dir, { recursive: true, force: true })] : [])]);
        for (const result of results) {
            if (result.status === "rejected") {
                options.logger.warn({ err: result.reason }, "agent domain: cleanup after the namespace ended failed");
            }
        }
    };
    try {
        const prepared = await prepareAgentDomainView({
            plan,
            historyRoot,
            authRoot: options.authRoot,
            run: run.dir,
            door: door.socket,
            gitPointersIn,
            ...opt("sshSocket", options.sshSocket),
        });
        const anchor = await startAgentDomain({ ...prepared, cleanup: async () => release(prepared.cleanup) });
        door.attach(anchor.namespace);
        return {
            pid: anchor.pid,
            namespace: anchor.namespace,
            cwd: anchor.cwd,
            plan,
            domain: { dir: run.dir, tmp: join(run.dir, "tmp"), door: door.socket },
            dispose: anchor.dispose,
        };
    } catch (error) {
        // A domain that never started has nothing running to wait for. Closing twice is a no-op, so a start that already
        // ran the cleanup itself loses nothing here.
        await release(async () => {});
        throw error;
    }
};
