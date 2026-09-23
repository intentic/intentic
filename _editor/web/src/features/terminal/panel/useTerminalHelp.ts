import type { TerminalSession } from "../terminalsQuery";
import { computed, ref, type Ref, watch } from "vue";

// The terminal-handover ask: the active tab shows the ask meant for its own session, since the pane needing an answer
// is the one right below it; an ask on another tab still reaches the owner through the chat and a notification.

export interface TerminalHelpHost {
    readonly sessions: Readonly<Ref<readonly TerminalSession[]>>;
    readonly activeName: Readonly<Ref<string | undefined>>;
    // Answers the ask on this sandbox's own daemon, the one that raised it.
    readonly reply: (answer: { kind: `terminal_help`; requestId: string; helped: boolean; note?: string }) => Promise<unknown>;
}

export const useTerminalHelp = ({ sessions, activeName, reply }: TerminalHelpHost) => {
    const help = computed(() => sessions.value.find((session) => session.name === activeName.value)?.help);
    const helpNote = ref(``);
    const replying = ref(false);
    watch(activeName, () => (helpNote.value = ``));

    const resolveHelp = async (helped: boolean): Promise<void> => {
        const open = help.value;
        // The daemon clears the ask, not this panel, so until the reply lands `help` still reads as open.
        if (open === undefined || replying.value) {
            return;
        }
        replying.value = true;
        const note = helpNote.value.trim();
        try {
            await reply({ kind: `terminal_help`, requestId: open.requestId, helped, ...(note === `` ? {} : { note }) });
            helpNote.value = ``;
        } finally {
            replying.value = false;
        }
    };

    return { help, helpNote, resolveHelp };
};
