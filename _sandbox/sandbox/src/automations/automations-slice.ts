import type { AgentOrigin } from "@intentic/sandbox-contract";
import type { IssuesStore } from "../issues/issues-store.js";
import type { ThreadSessionsStore } from "../sessions/thread-sessions.js";
import type { InstallsStore } from "../store/installs.js";
import type { OutboxSink, WebchatOutbox } from "../webchat/webchat-outbox.js";
import type { AutomationsStore } from "./automations-store.js";
import type { HeldWakesStore } from "./held-wakes-store.js";
import type { SendersStore } from "./senders-store.js";

// Automations and what a fire carries: held wakes, threads, senders, and the web chat outbox.
export interface AutomationsSlice {
    // Scheduled agent wake-ups; run history is a separate ledger joined on read, so callers see one store.
    readonly automations: AutomationsStore;
    // Wakes from requireApproval automations, held for the owner; /automations pending routes approve or reject.
    readonly heldWakes: HeldWakesStore;
    // Which conversation each inbound thread owns; lets a message stream remember instead of starting fresh.
    readonly threadSessions: ThreadSessionsStore;
    // Who has written to each listener source, admitted or not; what the sender rules picker offers by name.
    readonly senders: SendersStore;
    // Visitor chat replies written after the visitor's stream closed (an approved wake, a human writing as the agent);
    // the widget's poll drains them on the next page load.
    readonly webchatOutbox: WebchatOutbox;
    // Where a wake with no live visitor writes its answer. Composed here so the scheduler can attach the queue without
    // the automations subsystem importing webchat's code; undefined for any origin that answers through its gateway.
    readonly outboxStreamFor: (origin: AgentOrigin | undefined) => OutboxSink | undefined;
    // Bug reports from /intake, triaged from /issues; one instance so per-fingerprint writes don't race.
    readonly issues: IssuesStore;
    // Which sites loaded the reporter's script and which were turned away; the install panel's landing check.
    readonly issueInstalls: InstallsStore;
}
