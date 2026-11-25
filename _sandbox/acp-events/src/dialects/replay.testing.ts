import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { sessionUpdateEvent } from "../events.js";
import { type AcpDialect, childFrame, dialectReading, type DialectReader, type Json, placeUpdate, type VendorQuestion } from "./dialect.js";

// Replays a recorded ACP exchange through a dialect the way a connection routes it (runtimes/acp/acp-routing.ts):
// every message the agent sent, in order, read into the frames each session's turn would draw.
//
// The fixtures are JSON lines of `{ direction: "in" | "out", process, message }`, one JSON-RPC message each, the format
// Orca records in. The `grok-*` ones are Orca's own recordings of Grok Build (github.com/stablyai/orca at 5127e857010,
// src/main/acp/fixtures: s5-plan-approved, s6-background, s7-subagent-*; the subagent ones from 1.0.46), copied
// unchanged. Orca is MIT, Copyright (c) 2026 Lovecast Inc. `kimi-2.1.1-shell.jsonl` is transcribed, not recorded: its
// shell answers are the strings Kimi Code 2.1.1's source writes (Kimi is not installed where these were written).

export interface Line {
    readonly direction: "in" | "out";
    readonly message: { readonly id?: number; readonly method?: string; readonly params?: Json | SessionNotification; readonly result?: Json };
}

export interface Replay {
    // Each frame with the session whose turn draws it.
    readonly frames: readonly { readonly sessionId: string; readonly event: AgentEvent }[];
    readonly questions: readonly VendorQuestion[];
    readonly reader: DialectReader;
}

// SAFETY: each line is one message the recorder wrote, in the shape `Line` names.
const lineOf = (line: string): Line => JSON.parse(line) as Line;

export const fixture = (name: string): readonly Line[] =>
    readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(lineOf);

const CWD = "/workspace/project";

export const replay = (dialect: AcpDialect, lines: readonly Line[], until = lines.length): Replay => {
    const reader = dialect.reader();
    const frames: { sessionId: string; event: AgentEvent }[] = [];
    const questions: VendorQuestion[] = [];
    for (const { direction, message } of lines.slice(0, until)) {
        if (direction !== "in" || message.method === undefined) {
            continue;
        }
        if (message.method === "session/update") {
            // SAFETY: a recorded session/update is the protocol's notification.
            const notification = message.params as SessionNotification;
            const placed = placeUpdate(reader, notification);
            const event = sessionUpdateEvent(notification.update, CWD, dialectReading(dialect));
            const shown = event === undefined || placed.child === undefined ? event : childFrame(event, placed.child, notification.sessionId);
            for (const each of [...(shown === undefined ? [] : [shown]), ...placed.extra]) {
                frames.push({ sessionId: placed.sessionId, event: each });
            }
            continue;
        }
        // SAFETY: any message but a session/update is read as plain JSON, which every recorded message is.
        const params = (message.params as Json | undefined) ?? null;
        const asked = message.id === undefined ? undefined : dialect.question?.(message.method, params);
        if (asked !== undefined) {
            questions.push(asked);
        }
        for (const read of reader.notification(message.method, params) ?? []) {
            frames.push(...read.events.map((event) => ({ sessionId: read.sessionId, event })));
        }
    }
    return { frames, questions, reader };
};
