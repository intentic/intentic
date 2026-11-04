import { writeClipboard } from "@intentic/ui/clipboard";
import { t } from "@intentic/ui/i18n";
import { computed, inject, type InjectionKey, type Ref } from "vue";
import { useRouter } from "vue-router";
import { useRole } from "../../../../client/sandbox/useRole";
import { here, page } from "../../../../lib/routes/links";
import { type CommandResult, commandResultOf } from "../../../../models/conversations/commands/commandResult";
import {
    type LocalCommandName,
    localRunOf,
    offeredCommands,
    type SlashRow,
    slashRows,
} from "../../../../models/conversations/commands/slashCommands";
import { chatPickable, type PickerEntry, pickerEntries } from "../../../../models/conversations/accounts/modelPickerState";
import type { ConversationView } from "../../../../models/conversations/panel/useChat-view";
import type { Conversation } from "../../../../models/conversations/session/conversation";
import { startAgent } from "../../../../models/fleet/agentActions";
import { useAgents } from "../../../../models/fleet/useAgents";
import { providerWithheld } from "../../../../models/providers/aiReach";
import { effortsFor } from "../../../../models/providers/effortScale";
import type { InputHistory } from "../../drafts/inputHistory";
import { modeOptions } from "../../models/catalog";

// THE COMPOSER'S OWN `/` COMMANDS AT WORK (slashCommands.ts says which, and why they never reach the agent). Send runs one
// before anything else reads the draft: the box empties, the line joins the recall ring as a sent message does, and the
// answer is a control opening (the model picker), a setting moving, or a card over the composer (commandResult.ts). The
// send itself is wrapped rather than taught, so Enter, the button and Cmd/Ctrl+Enter all answer the same way.

// What a command reaches beyond the pane, injected so a suite hands its fakes rather than replacing modules by path.
export interface CommandEffects {
    // A new chat, the New agent press's own (`/clear`): this one stays on the board, as Claude Code keeps it resumable.
    readonly startChat: () => void;
    readonly openSettings: () => void;
    readonly rename: (conversation: Conversation, title: string) => void;
    readonly copy: (text: string) => Promise<boolean>;
}
export const COMMAND_EFFECTS: InjectionKey<CommandEffects> = Symbol(`commandEffects`);

const realEffects = (): CommandEffects => {
    const router = useRouter();
    return {
        startChat: () => void startAgent(),
        openSettings: () => void router.push(here(page.sandboxSettings(`agent`))),
        rename: (conversation, title) => void useAgents().rename(conversation.conversationId, title),
        copy: (text) => writeClipboard(text),
    };
};

export interface CommandsHost {
    readonly view: ConversationView;
    // The model pill's panel, which a bare `/model` opens.
    readonly modelOpen: Ref<boolean>;
    // Armed, the box's words are the agent's own lines, so a `/` in them is text.
    readonly voiceAgent: Readonly<Ref<boolean>>;
    readonly history: Readonly<Ref<InputHistory | undefined>>;
    // Re-measures the box once it empties.
    readonly grow: () => void;
}

const note = (typed: string, text: string, tone?: `warning`): CommandResult =>
    tone === undefined ? { kind: `note`, typed, text } : { kind: `note`, typed, text, tone };

// The model a `/model <words>` names: an id or label said whole first, else one holding the words, this chat's provider
// before the others. Mid-turn only a same-provider swap is allowed, as the picker allows it.
const modelNamed = (words: string, view: ConversationView): PickerEntry | undefined => {
    const needle = words.toLowerCase();
    const provider = view.provider.value;
    const pickable = pickerEntries.value
        .filter((entry) => chatPickable(entry) && !providerWithheld(entry.provider) && (!view.streaming.value || entry.provider === provider))
        .toSorted((a, b) => Number(b.provider === provider) - Number(a.provider === provider));
    const said = (entry: PickerEntry): readonly string[] => [entry.value.toLowerCase(), entry.label.toLowerCase()];
    return pickable.find((entry) => said(entry).includes(needle)) ?? pickable.find((entry) => said(entry).some((text) => text.includes(needle)));
};

// Each command's answer, given what was typed after it; undefined where the answer is a control that opened. The
// readouts are named only: the card reads them live from the pane.
const answersOf = (
    host: CommandsHost,
    seams: { readonly effects: CommandEffects; readonly send: () => void; readonly rows: () => readonly SlashRow[] },
) => {
    const { view } = host;
    const { effects, send } = seams;
    const selection = () => view.conversation.value.selection;
    return {
        help: (_args: string, typed: string): CommandResult => ({ kind: `help`, typed, rows: seams.rows() }),
        usage: (_args: string, typed: string): CommandResult => ({ kind: `usage`, typed }),
        context: (_args: string, typed: string): CommandResult => ({ kind: `context`, typed }),
        status: (_args: string, typed: string): CommandResult => ({ kind: `status`, typed }),
        todos: (_args: string, typed: string): CommandResult => ({ kind: `todos`, typed }),
        model: (args: string, typed: string): CommandResult | undefined => {
            const entry = args === `` ? undefined : modelNamed(args, view);
            if (entry === undefined) {
                host.modelOpen.value = true;
                return args === `` ? undefined : note(typed, t(`chat.slashCommands.noModelMatch`, { query: args }), `warning`);
            }
            selection().apply({ kind: `selectModel`, pick: entry });
            return note(typed, t(`chat.slashCommands.modelSet`, { model: entry.label }));
        },
        effort: (args: string, typed: string): CommandResult | undefined => {
            const { provider, model, thinking, auto, capabilities } = selection();
            const levels = auto.value || !capabilities.value.effort ? [] : effortsFor(provider.value, model.value, thinking.value);
            if (levels.length === 0) {
                return note(typed, t(`chat.slashCommands.noEffort`), `warning`);
            }
            if (args === ``) {
                return { kind: `effort`, typed };
            }
            const level = levels.find((option) => [option.value, option.label].some((said) => said.toLowerCase() === args.toLowerCase()));
            if (level === undefined) {
                return note(
                    typed,
                    t(`chat.slashCommands.noEffortMatch`, { level: args, levels: levels.map((option) => option.value).join(`, `) }),
                    `warning`,
                );
            }
            selection().apply({ kind: `setEffort`, effort: level.value });
            return note(typed, t(`chat.slashCommands.effortSet`, { level: level.label }));
        },
        plan: (args: string, typed: string): CommandResult | undefined => {
            if (!modeOptions(view.capabilities.value).some((mode) => mode.value === `plan`)) {
                return note(typed, t(`chat.slashCommands.noPlanMode`), `warning`);
            }
            view.mode.value = `plan`;
            if (args === ``) {
                return note(typed, t(`chat.slashCommands.planOn`));
            }
            // The task goes as this chat's next message, now planned: the CLI's `/plan <task>`.
            view.draft.value = args;
            send();
            return undefined;
        },
        clear: () => {
            effects.startChat();
            return undefined;
        },
        rename: (args: string, typed: string): CommandResult => {
            if (args === ``) {
                return note(typed, t(`chat.slashCommands.renameUsage`), `warning`);
            }
            effects.rename(view.conversation.value, args);
            return note(typed, t(`chat.slashCommands.renamed`, { title: args }));
        },
        copy: (_args: string, typed: string): CommandResult | undefined => {
            const reply = view.messages.value.findLast((message) => message.role === `assistant` && message.text.trim() !== ``);
            if (reply === undefined) {
                return note(typed, t(`chat.slashCommands.nothingToCopy`), `warning`);
            }
            const result = commandResultOf(view.conversation.value);
            void effects.copy(reply.text).then((landed) => {
                result.value = landed ? note(typed, t(`chat.slashCommands.copied`)) : note(typed, t(`chat.slashCommands.copyFailed`), `warning`);
            });
            return undefined;
        },
        stop: (_args: string, typed: string): CommandResult | undefined => {
            if (!view.turnStoppable.value || view.ending.value !== undefined) {
                return note(typed, t(`chat.slashCommands.nothingRunning`));
            }
            view.stop();
            return undefined;
        },
        config: () => {
            effects.openSettings();
            return undefined;
        },
    } satisfies Record<LocalCommandName, (args: string, typed: string) => CommandResult | undefined>;
};

export const useComposerCommands = (host: CommandsHost) => {
    const { view } = host;
    const effects = inject(COMMAND_EFFECTS, realEffects, true);
    const { isGuest, canShip } = useRole();
    const offered = computed(() => offeredCommands({ guest: isGuest.value, maintainer: canShip.value }));
    // What the `/` list offers and what Enter runs: ours beside the provider's, a clash settled as Claude Code settles it.
    const rows = computed(() => slashRows(offered.value, view.availableCommands.value));
    const result = computed(() => commandResultOf(view.conversation.value));
    // The composer's own send, which `/plan <task>` hands its task to once the mode is set.
    let sendOn: () => void = () => undefined;
    const answers = answersOf(host, { effects, send: () => sendOn(), rows: () => rows.value });

    // True when the draft was one of ours and has been answered; false leaves the send to go on as it would have.
    const runTyped = (): boolean => {
        const text = view.draft.value;
        const run = host.voiceAgent.value || view.editing.value !== undefined ? undefined : localRunOf(text, rows.value, offered.value);
        if (run === undefined) {
            return false;
        }
        view.draft.value = ``;
        host.history.value?.record(text.trim());
        host.grow();
        result.value.value = undefined;
        result.value.value =
            run.kind === `unavailable`
                ? note(run.typed, t(`chat.slashCommands.unavailable`, { name: run.typed }), `warning`)
                : answers[run.name](run.args, run.typed);
        return true;
    };

    return {
        rows,
        // The send with our commands answered ahead of it; anything else clears the last answer and goes as before.
        intercept: <S extends { readonly submit: (options?: { readonly now?: boolean }) => void }>(send: S): S => {
            sendOn = () => send.submit();
            return {
                ...send,
                submit: (options?: { readonly now?: boolean }) => {
                    if (!runTyped()) {
                        result.value.value = undefined;
                        send.submit(options);
                    }
                },
            };
        },
    };
};
