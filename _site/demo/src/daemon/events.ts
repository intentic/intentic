import type { SystemEvent } from "@intentic/sandbox-contract/events/system-events";
import type { SandboxHandlerInput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { Frames, type ProcedureCall } from "@intentic/contract-serve";
import { homeSandboxOf } from "../fixture/home/sandboxes";
import { watchOwnBrowser } from "../browser";
import { REPOS } from "../fixture/workspace";
import { demoMode } from "../mode";
import { boardAgents, listeners, OWNER, roster, STARTED_AT, TEAMMATE } from "./roster";

// The /events stream: the boot frame, the board, presence, a heartbeat inside the browser's 10s watchdog, and a
// synthetic runtime tick, since the fixture's data doesn't change on its own.

// The visitor's own window changed (a tab opened, closed or went somewhere): the list is re-read, as the daemon's push
// makes it.
watchOwnBrowser(() => {
    for (const listener of listeners) {
        listener({ kind: `runtimeChanged`, domains: [`browsers`] });
    }
});

// Heartbeat interval for /events, inside the browser's 10s watchdog.
const HEARTBEAT_MS = 2_000;

// Interval for a synthetic `runtimeChanged` push, since the fixture's data doesn't change on its own.
const RUNTIME_TICK_MS = 10_000;

// Each stream is one sandbox's (fixture/home/sandboxes.ts): every board it is sent is that sandbox's board.
export const events = (_input: SandboxHandlerInput<`system`, `events`>, call: ProcedureCall): Frames<SystemEvent> =>
    new Frames((sink) => {
        const sandbox = homeSandboxOf(call.url);
        const listener = (event: SystemEvent): void => sink.emit(event.kind === `agents` ? { ...event, agents: boardAgents(sandbox) } : event);
        listeners.add(listener);

        sink.emit({ kind: `hello`, workspaceId: `demo-workspace`, build: `demo`, boot: { ready: true, startedAt: STARTED_AT, steps: [] } });
        sink.emit({ kind: `agents`, agents: boardAgents(sandbox), rev: roster.rev });
        sink.emit({ kind: `reposChanged`, repos: [...REPOS] });
        sink.emit({ kind: `presence`, users: demoMode.teammate ? [OWNER, TEAMMATE] : [OWNER] });

        const beat = setInterval(() => sink.emit({ kind: `heartbeat`, rev: roster.rev }), HEARTBEAT_MS);
        const runtime = setInterval(
            () => sink.emit({ kind: `runtimeChanged`, domains: [`terminals`, `browsers`, `panels`, `ports`, `subagents`] }),
            RUNTIME_TICK_MS,
        );
        return () => {
            clearInterval(beat);
            clearInterval(runtime);
            listeners.delete(listener);
        };
    });
