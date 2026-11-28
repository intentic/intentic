import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { S2sContactScope } from "@intentic/sandbox-contract/schemas/s2s";
import { opt } from "../opt.js";
import type { ContactRow } from "./contacts/contacts-store.js";

// WHAT AUTOMATIONS HEAR (docs/architecture/messages.md, "Automations, and nothing else"): a message, a report, a contact
// request or a task request, once stored, is handed on as an event of the core listener source `s2s` and nothing else; it
// starts no agent by itself. The composition root dispatches each through the automations' listener door
// (bootstrap/boot-schedulers.ts), since automations sit above this module. A report is heard once the issues inbox took
// it (account-routing/messages/report-kind.ts), a task request once it is filed here (links/contacts/).

// The listener provider every event here goes out under (automations/catalog.ts declares the source).
export const S2S_LISTENER_PROVIDER = "s2s";

export type S2sHeard =
    | {
          readonly event: "message";
          readonly contact: ContactRow;
          // The thread here, and the message's envelope id.
          readonly thread: string;
          readonly envelope: string;
          readonly subject?: string | undefined;
          readonly text: string;
          readonly attachments: readonly string[];
          readonly at: number;
      }
    | {
          readonly event: "report";
          readonly contact: ContactRow;
          readonly envelope: string;
          // The project it is about, and the line the problem is shown by.
          readonly project: string;
          readonly title: string;
          readonly at: number;
      }
    | { readonly event: "contact.request"; readonly contact: ContactRow; readonly envelope: string; readonly note?: string | undefined; readonly at: number }
    | {
          // A task a contact handed over, once filed here (links/contacts/): it runs, or waits for the owner, by the contact's grant
          // whether or not an automation hears it.
          readonly event: "task.request";
          readonly contact: ContactRow;
          readonly envelope: string;
          readonly task: string;
          readonly title?: string | undefined;
          // The asking side's id for it, and the conversation it opened here.
          readonly requestId: string;
          readonly conversationId: string;
          readonly at: number;
      };

export type S2sHearing = (heard: S2sHeard) => Promise<void>;

// The scope as a trigger's second filter reads it: `sandbox`, or the person's email.
const scopeWord = (scope: S2sContactScope): string => (scope.kind === "sandbox" ? "sandbox" : scope.person);

const contentOf = (heard: S2sHeard): string => {
    if (heard.event === "task.request") {
        return heard.title === undefined ? heard.task : `${heard.title}\n\n${heard.task}`;
    }
    if (heard.event === "message") {
        return heard.subject === undefined ? heard.text : `${heard.subject}\n\n${heard.text}`;
    }
    if (heard.event === "report") {
        return `A problem report about ${heard.project}: ${heard.title}`;
    }
    return heard.note ?? `${heard.contact.document.name} (${heard.contact.address}) asks to be a contact of this sandbox.`;
};

// What a woken agent reads beside the words: the contact, the scope, and for a message its thread and files.
type HeardExtra = {
    readonly contact: string;
    readonly scope: string;
    readonly kind: S2sHeard["event"];
    readonly envelope: string;
    readonly thread?: string;
    readonly attachments?: readonly string[];
    readonly subject?: string;
    readonly project?: string;
    // A task request's id on the asking side, and the conversation it opened here.
    readonly requestId?: string;
    readonly conversationId?: string;
};

const extraOf = (heard: S2sHeard): HeardExtra => {
    if (heard.event === "task.request") {
        const { contact, envelope, requestId, conversationId, title } = heard;
        return { contact: contact.id, scope: scopeWord(contact.scope), kind: heard.event, envelope, requestId, conversationId, ...opt("subject", title) };
    }
    const base = { contact: heard.contact.id, scope: scopeWord(heard.contact.scope), kind: heard.event, envelope: heard.envelope };
    if (heard.event === "message") {
        return { ...base, thread: heard.thread, attachments: heard.attachments, ...opt("subject", heard.subject) };
    }
    return heard.event === "report" ? { ...base, project: heard.project } : base;
};

/** One heard event as the listener door takes it: the contact its channel and sender, its thread, its scope the branch. */
export const listenerMessageOf = (heard: S2sHeard): ListenerMessage => ({
    provider: S2S_LISTENER_PROVIDER,
    type: heard.event,
    id: heard.envelope,
    channelId: heard.contact.address,
    ...opt("thread", heard.event === "message" ? heard.thread : undefined),
    author: { id: heard.contact.address, name: heard.contact.name ?? heard.contact.document.name },
    content: contentOf(heard),
    branch: scopeWord(heard.contact.scope),
    timestamp: new Date(heard.at).toISOString(),
    extra: extraOf(heard),
});
