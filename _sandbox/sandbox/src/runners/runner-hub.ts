import type { ContractRouterClient } from "@orpc/contract";
import type { runnerContract, RunnerFacts, RunnerHello, RunnerSummary } from "@intentic/sandbox-contract";

/* WHAT THE LIVE HALF KNOWS about a runner, which is deliberately less than a row shows: this hub holds
 * sockets, so it can say whether one is up, what it announced about its build, and what it last measured.
 * Which machine holds it comes from the enrollment, and whether its build matches this sandbox is a
 * comparison neither end makes (runner-parity.ts). Both are added where the row is assembled. */
export type RunnerLiveState = Omit<RunnerSummary, "id" | "host" | "parity">;

/* The live half of the runner registry: which of this sandbox's runners are holding a socket right now, and
 * the typed client for each (runners-store.ts is the credential half; docs/remote-runners-plan.md, workspace
 * root, is the design). The host hub's shape without its host-specific limbs, no scopes to push (a runner has
 * no owner-ticked grant, the parent is its whole authority) and no MCP pipe or tool cache (runnerContract is
 * typed end to end, both ends being this daemon's own codebase by construction).
 *
 * Everything here is in memory, deliberately: "online" is a fact about a socket, and a socket does not
 * survive a restart. After one, every runner reconnects on its own backoff and re-announces itself. */

// The typed client for one runner, every call in runnerContract, over its own socket.
export type RunnerClient = ContractRouterClient<typeof runnerContract>;

// A runner that goes silent without closing its socket would otherwise look reachable; frequent enough to
// stay inside every idle timeout in the path, the host hub's number for the host hub's reasons.
const HEARTBEAT_MS = 30_000;

// What a runner's hello asserts about its build and declared shape, kept beside the live socket so the parity
// card can read it.
type RunnerParity = Pick<RunnerHello, "version" | "image" | "channel" | "overlayHash" | "definitionToml">;

interface LiveRunner {
    readonly client: RunnerClient;
    readonly close: (code: number, reason: string) => void;
    readonly heartbeat: NodeJS.Timeout;
    parity: RunnerParity;
    facts: RunnerFacts | undefined;
    lastSeen: number;
}

export interface RunnerHub {
    // Take over as THE connection for this runner, closing any socket it left behind (a machine waking from
    // sleep reconnects long before the old socket's keepalive gives up). Returns a detach for the socket's
    // own close handler; calling it after a newer connection replaced this one does nothing.
    readonly attach: (id: string, connection: { client: RunnerClient; close: (code: number, reason: string) => void; parity: RunnerParity }) => () => void;
    // What the runner answered to `describe`, refreshed whenever the parent asks it fresh.
    readonly observe: (id: string, facts: RunnerFacts) => void;
    /* The runner's declared shape as its hello last claimed it (a settings-only sandbox.toml), and the door
     * that updates the claim after a successful applyDefinition push — the runner's settings just changed to
     * exactly what was sent, and waiting for a reconnect would show stale drift on a fixed runner. */
    readonly definitionToml: (id: string) => string | undefined;
    readonly adoptDefinition: (id: string, toml: string) => void;
    // The typed client for a connected runner, or undefined when it is offline.
    readonly client: (id: string) => RunnerClient | undefined;
    // Cut a runner off now: the owner revoking it, or the capability being removed.
    readonly disconnect: (id: string, reason: string) => void;
    readonly online: (id: string) => boolean;
    readonly state: (id: string) => RunnerLiveState;
}

export const createRunnerHub = (logger: { warn: (data: object, message: string) => void }): RunnerHub => {
    const live = new Map<string, LiveRunner>();
    // What each runner reported the last time it was up, kept after it goes offline so the card can say
    // "last seen" and still name its image instead of going blank the moment a machine sleeps.
    const seen = new Map<string, { parity: RunnerParity; facts: RunnerFacts | undefined; lastSeen: number }>();

    const drop = (id: string, runner: LiveRunner): void => {
        clearInterval(runner.heartbeat);
        seen.set(id, { parity: runner.parity, facts: runner.facts, lastSeen: Date.now() });
        live.delete(id);
    };

    return {
        attach: (id, connection) => {
            const previous = live.get(id);
            if (previous !== undefined) {
                clearInterval(previous.heartbeat);
                previous.close(1000, "replaced");
                live.delete(id);
            }
            const runner: LiveRunner = {
                client: connection.client,
                close: connection.close,
                heartbeat: setInterval(() => {
                    void connection.client.ping().catch((err: unknown) => {
                        logger.warn({ err, id }, "runner: heartbeat failed, dropping the connection");
                        connection.close(1001, "no answer");
                        const current = live.get(id);
                        if (current?.client === connection.client) {
                            drop(id, current);
                        }
                    });
                }, HEARTBEAT_MS),
                parity: connection.parity,
                facts: seen.get(id)?.facts,
                lastSeen: Date.now(),
            };
            live.set(id, runner);
            return () => {
                const current = live.get(id);
                if (current === runner) {
                    drop(id, runner);
                }
            };
        },
        observe: (id, facts) => {
            const runner = live.get(id);
            if (runner === undefined) {
                return;
            }
            runner.facts = facts;
            runner.lastSeen = Date.now();
        },
        // Read from live OR remembered: a sleeping runner's drift is still worth showing, its settings did
        // not change by going offline.
        definitionToml: (id) => (live.get(id) ?? seen.get(id))?.parity.definitionToml,
        adoptDefinition: (id, toml) => {
            const runner = live.get(id);
            if (runner === undefined) {
                return;
            }
            runner.parity = { ...runner.parity, definitionToml: toml };
        },
        client: (id) => live.get(id)?.client,
        disconnect: (id, reason) => {
            const runner = live.get(id);
            if (runner === undefined) {
                return;
            }
            clearInterval(runner.heartbeat);
            runner.close(1000, reason);
            seen.delete(id);
            live.delete(id);
        },
        online: (id) => live.has(id),
        state: (id) => {
            const runner = live.get(id);
            const remembered = runner ?? seen.get(id);
            return {
                online: runner !== undefined,
                ...(remembered !== undefined
                    ? {
                          version: remembered.parity.version,
                          image: remembered.parity.image,
                          ...(remembered.parity.channel !== undefined ? { channel: remembered.parity.channel } : {}),
                          ...(remembered.parity.overlayHash !== undefined ? { overlayHash: remembered.parity.overlayHash } : {}),
                          lastSeen: remembered.lastSeen,
                      }
                    : {}),
                ...(remembered?.facts !== undefined ? { facts: remembered.facts } : {}),
            };
        },
    };
};
