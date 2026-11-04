import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../../composition.js";
import { sealJailWanted } from "../../../conversations/seal/seal-jail.js";
import { startAnchor, type TurnPlacement } from "../../../conversations/worktrees/isolation.js";
import { jailPlanOf, peopleShellArgs } from "../../../conversations/worktrees/turn-sandbox.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { enterJailStore, leaveJailStore } from "../../../sessions/jail-store.js";
import { armShellJail, disarmShellJail, shellJailFiles } from "../../../terminal/shell-jail.js";
import { gitsRoot } from "../../../workspace/layout/git-dir-owners.js";
import { opt } from "../../../opt.js";
import { retryNote } from "./setup-refusal.js";

/* THE JAIL PRIVATE CONVERSATIONS PUT EVERY TURN IN (2026-11-04). While the house rule lets a conversation be private, or
   one still is (conversations/seal/seal-jail.ts), a turn that would run as root over the shared tree, in a worktree of
   its own or in the main checkout, runs in the sandbox a fenced turn gets (conversations/worktrees/turn-sandbox.ts),
   fenced to the whole workspace: every folder as before and git whole, but the history volume, the workspace's secrets
   and every other conversation's runtime files out of its reach. Asked as each turn is placed, so a change applies from
   the next turn; while it is not wanted, a turn is placed exactly as it always was. A fenced conversation is already
   in a sandbox of its own and never comes here. */

export type JailDecision = { readonly jailed: false } | { readonly jailed: true } | { readonly refused: string };

export interface JailAsks {
    readonly wanted: () => Promise<boolean>;
    readonly sandboxAvailable: () => Promise<boolean>;
}

// Only a runtime whose own state the sandbox can carry runs in it, as for a fenced turn (stream-agent.ts fencedRefusal):
// Codex and Cursor keep one sandbox-wide home holding every conversation's sessions, and a runtime that never enters a
// namespace would read the whole volume. Refused, never run open.
export const jailDecision = async (asks: JailAsks, input: Pick<RoutedTurn, "agent" | "harness">): Promise<JailDecision> => {
    if (!(await asks.wanted())) {
        return { jailed: false };
    }
    const capabilities = capabilitiesOf(input.agent, input.harness);
    if (capabilities.isolation !== "namespace" || capabilities.runtime !== "claude-code") {
        return {
            refused: "Conversations in this sandbox can be private, so every turn runs in an isolated environment, and only Claude Code can run in one so far. Switch this conversation to a Claude model to continue.",
        };
    }
    if (!(await asks.sandboxAvailable())) {
        return {
            refused: "Conversations in this sandbox can be private, so every turn runs in an isolated environment, and this sandbox cannot build one (bubblewrap with user namespaces). Ask a maintainer to recreate the sandbox.",
        };
    }
    return { jailed: true };
};

type ShellServices = Pick<Services, "sealHouse" | "orgPolicy" | "agents" | "workspace" | "config" | "sshAgent">;
type JailServices = ShellServices & Pick<Services, "turnIsolation" | "logger">;

/**
 * People's shells follow the same rule (terminal/shell-jail.ts): every new one in the jail while it is wanted, with the
 * owner's ssh agent the server hands every pane, and the server's own line back once it is not. Asked before netd opens
 * a terminal, and as each jailed turn is placed, so a shell opened before the jail is ended without waiting for the next.
 */
export const placePeopleShells = async (services: ShellServices, wanted?: boolean): Promise<void> => {
    if (!(wanted ?? (await sealJailWanted(services)))) {
        await disarmShellJail();
        return;
    }
    const jail = { gits: gitsRoot(services.config.historyRoot), sshSocket: services.sshAgent.owner };
    await armShellJail(peopleShellArgs(services.workspace.root, jail, shellJailFiles().empty));
};

// The store the jailed turn's runtime writes: the conversation's own, its current session moved in first; a turn with
// no conversation gets a throwaway one, since it has nothing to resume and nobody to share one with.
const jailStoreOf = async (services: JailServices, input: RoutedTurn): Promise<string> => {
    const id = input.conversationId;
    if (id === undefined) {
        return mkdtemp(join(tmpdir(), "intentic-jail-sessions-"));
    }
    const entry = services.agents.entry(id);
    return enterJailStore(services.workspace.root, services.config.historyRoot, { id, sessionId: entry?.sessionId, identity: entry?.identity ?? {} });
};

/**
 * Where an unfenced root-mode turn runs while private conversations need the jail: a placement in it, a refusal, or
 * undefined when the jail is not wanted, for the caller to place the turn as before (once the conversation's sessions
 * are back in the shared store, if an earlier turn moved them out).
 */
export const jailedPlacementOf = async (
    services: JailServices,
    input: RoutedTurn,
    localCwd: string,
    sshSocket: string | undefined,
): Promise<TurnPlacement | { readonly refused: string } | undefined> => {
    const decision = await jailDecision({ wanted: () => sealJailWanted(services), sandboxAvailable: () => services.turnIsolation.sandboxAvailable() }, input);
    if ("refused" in decision) {
        return decision;
    }
    if (!decision.jailed) {
        const id = input.conversationId;
        const entry = id === undefined ? undefined : services.agents.entry(id);
        if (id !== undefined && entry !== undefined) {
            await leaveJailStore(services.workspace.root, services.config.historyRoot, { id, identity: entry.identity });
        }
        return undefined;
    }
    void placePeopleShells(services, true).catch((error) => services.logger.warn({ err: error }, "jail: people's shells could not be placed in it"));
    const sessions = await jailStoreOf(services, input);
    const base = await services.turnIsolation.planFor(localCwd, undefined);
    const plan = jailPlanOf(base, sessions, { gits: gitsRoot(services.config.historyRoot), ...opt("sshSocket", sshSocket) });
    return { plan, anchor: await startAnchor(plan, { onRetry: retryNote(services, input) }) };
};
