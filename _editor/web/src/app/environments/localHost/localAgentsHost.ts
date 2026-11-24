import type { Ref } from "vue";

/* AGENTS ON THIS COMPUTER ITSELF (2026-11-24): a harness the reader already has (Claude Code, Codex), run in the
   window's folder outside every sandbox, with the sandbox's own chat on it (local/agents/). The turns are the app's
   sidecar's to run and serve (_devices/host-agents); what must not be a page's own word goes through the app: the
   reader's yes to an agent that is not contained by anything, which the sidecar holds every turn to. */
export interface LocalAgentsHost {
    /** Whether the reader has turned agents on for this computer; the app keeps their answer, for every window. */
    readonly accepted: Readonly<Ref<boolean>>;
    /** How many turns run on this computer now, in any window. */
    readonly running: Readonly<Ref<number>>;
    /** Reads both from the app and keeps them current; safe to call from every screen that draws them. */
    follow(): Promise<void>;
    /** Turns agents on for this computer. Rejects with the app's sentence. */
    accept(): Promise<void>;
    /**
     * A first message the app holds for this window's folder (the recovery panel's "Ask an agent on this computer"),
     * handed over once; nothing when none waits, or it was written for another window's folder.
     */
    takeDraft(): Promise<string | undefined>;
    /** Calls `listener` whenever the app says such a message waits for some window; the returned function stops it. */
    onDraft(listener: () => void): () => void;
}
