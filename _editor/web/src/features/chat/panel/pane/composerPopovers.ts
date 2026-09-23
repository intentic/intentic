import type { AgentCommand, Persona, RunnerSummary } from "@intentic/sandbox-contract";
import { computed, nextTick, type Ref, ref, watch } from "vue";
import { otherBoxes } from "../../../sandbox/live/fleetAcross";
import { modelLabelFor } from "../../accounts/providerCatalog";
import type { QuickPick, QuickPickSources } from "../../composer/composerQuickPick";
import { drillMention, fileMention, mentionQueryAt, replaceMention } from "../../composer/useMentions";
import { pickerEntries } from "../../models/modelPickerState";
import { effortsFor } from "../../models/run-settings/effortScale";
import { ensureProviderCommands } from "../../models/useChat-catalog";
import { providerReady } from "../../session/access";
import type { Conversation } from "../../session/conversation";
import type { ConversationView } from "../useChat-view";
import { placeConversation } from "./composerControls";

// The two lists that open over one pane's composer as it is typed into: an `@`-token at the caret opens the picker over
// files and the four turn settings, and a leading `/` with the caret still in the first token opens the provider's
// commands. Escape dismisses until the token changes; a pick rewrites the draft and lands the caret after it.

// The pill whose value an `@` pick just changed, pulsed once: the token vanishes from the text, so the eye is sent to
// where the setting now lives.
export type FlashedControl = `persona` | `placement` | `model` | `effort`;
const FLASH_MS = 700;

export interface PopoversHost {
    readonly view: ConversationView;
    readonly input: Readonly<Ref<HTMLTextAreaElement | null>>;
    readonly grow: () => void;
    readonly personas: Readonly<Ref<readonly Persona[]>>;
    readonly pickPersona: (id: string | undefined) => void;
    // Where the chat may be placed: nowhere else while it lives in another box, or once the board has seen it.
    readonly placement: {
        readonly remote: Readonly<Ref<boolean>>;
        readonly shown: Readonly<Ref<boolean>>;
        readonly runners: Readonly<Ref<readonly RunnerSummary[]>>;
    };
    // A picked workflow greys the row's setting pills, and the picker withholds the same kinds.
    readonly steered: Readonly<Ref<boolean>>;
    // A guest is shown no tree, so nothing to mention.
    readonly isGuest: Readonly<Ref<boolean>>;
}

// What the `@` picker may change, mirroring the pill row control for control: a kind the row refuses is `undefined`.
const quickSourcesOf = (chat: Conversation, host: PopoversHost): QuickPickSources => {
    const steered = host.steered.value;
    const { selection } = chat;
    const provider = selection.provider.value;
    return {
        persona: steered || host.placement.remote.value ? undefined : { personas: host.personas.value, picked: selection.actsAs.value },
        sandbox:
            !host.placement.shown.value || chat.registered.value
                ? undefined
                : {
                      runners: host.placement.runners.value.filter((runner) => runner.online),
                      boxes: otherBoxes.value.filter((box) => box.state === `ready`).map((box) => ({ id: box.sandbox.id, name: box.sandbox.name })),
                      box: chat.box.value,
                      runner: chat.runner.value,
                  },
        // Mid-stream only a same-provider swap is allowed (the `selectModel` pick), so the rest aren't listed.
        model: steered
            ? undefined
            : {
                  entries: host.view.streaming.value ? pickerEntries.value.filter((entry) => entry.provider === provider) : pickerEntries.value,
                  provider,
                  model: selection.model.value,
                  label: modelLabelFor(provider, selection.model.value),
                  isReady: providerReady,
              },
        effort: steered || selection.auto.value || !selection.capabilities.value.effort ? undefined : effortSourceOf(chat),
    };
};
const effortSourceOf = (chat: Conversation): NonNullable<QuickPickSources[`effort`]> => {
    const { selection } = chat;
    return { options: effortsFor(selection.provider.value, selection.model.value, selection.thinking.value), picked: selection.effort.value };
};

// A setting pick goes through the same setter its pill uses and leaves no text behind; which pill it changed.
const applyQuickPick = (chat: Conversation, pick: QuickPick, pickPersona: (id: string | undefined) => void): FlashedControl | undefined => {
    switch (pick.kind) {
        case `persona`:
            pickPersona(pick.id);
            return `persona`;
        case `sandbox`:
            placeConversation(chat, { box: pick.box, runner: pick.runner });
            return `placement`;
        case `model`:
            chat.selection.apply({ kind: `selectModel`, pick: pick.entry });
            return `model`;
        case `effort`:
            chat.selection.apply({ kind: `setEffort`, effort: pick.value });
            return `effort`;
        default:
            return undefined;
    }
};

export const useComposerPopovers = (host: PopoversHost) => {
    const { draft, availableCommands } = host.view;
    const caret = ref(0);
    const popoverDismissed = ref(false);
    const activeMention = computed(() => mentionQueryAt(draft.value, caret.value));
    const slashQuery = computed<string | undefined>(() => {
        if (availableCommands.value.length === 0 || !draft.value.startsWith(`/`)) {
            return undefined;
        }
        const upto = draft.value.slice(1, caret.value);
        return caret.value >= 1 && !/\s/.test(upto) ? upto : undefined;
    });
    watch([() => activeMention.value?.query, slashQuery], () => {
        popoverDismissed.value = false;
    });
    // Commands the typed token could still become; nothing to show closes the popover rather than drawing an empty one.
    const commandMatches = computed<readonly AgentCommand[]>(() => {
        const needle = slashQuery.value?.toLowerCase();
        return needle === undefined ? [] : availableCommands.value.filter((command) => command.name.toLowerCase().includes(needle));
    });
    // Files complete against this workspace's tree, so a conversation in another box is offered none.
    const filesOffered = computed(() => !host.placement.remote.value);
    const quickSources = computed(() => quickSourcesOf(host.view.conversation.value, host));
    const quickOffered = computed(() => filesOffered.value || Object.values(quickSources.value).some((source) => source !== undefined));
    const mentionOpen = computed(() => activeMention.value !== undefined && !popoverDismissed.value && quickOffered.value && !host.isGuest.value);

    // Only when this composer has none (ensureProviderCommands is a no-op once known), on a provider switch or a typed
    // `/`; never from inside `availableCommands`, where a getter's fetch would refire on every re-evaluation.
    watch(
        [host.view.provider, () => draft.value.startsWith(`/`)],
        ([target]) => {
            if (availableCommands.value.length === 0) {
                void ensureProviderCommands(target);
            }
        },
        { immediate: true },
    );

    // Puts the picked text into the draft and lands the caret after it, keeping the box focused.
    const applyDraftEdit = (text: string, nextCaret: number): void => {
        draft.value = text;
        void nextTick(() => {
            const el = host.input.value;
            if (el) {
                el.focus();
                el.setSelectionRange(nextCaret, nextCaret);
            }
            caret.value = nextCaret;
            host.grow();
        });
    };

    const flashed = ref<FlashedControl>();
    const flash = (control: FlashedControl): void => {
        flashed.value = control;
        setTimeout(() => {
            if (flashed.value === control) {
                flashed.value = undefined;
            }
        }, FLASH_MS);
    };

    return {
        caret,
        popoverDismissed,
        activeMention,
        commandMatches,
        filesOffered,
        quickSources,
        mentionOpen,
        commandOpen: computed(() => !mentionOpen.value && commandMatches.value.length > 0 && !popoverDismissed.value),
        flashed,
        // Whether this draft sends as a command: the whole first word against the published names, the same rule the
        // daemon applies on arrival (the popover matches only the typed token).
        commandRun: computed<AgentCommand | undefined>(() => {
            const text = draft.value.trimStart();
            if (!text.startsWith(`/`)) {
                return undefined;
            }
            const name = text.slice(1).split(/\s/, 1)[0] ?? ``;
            return availableCommands.value.find((command) => command.name === name);
        }),
        syncCaret: (): void => {
            caret.value = host.input.value?.selectionStart ?? draft.value.length;
        },
        // A file becomes `@path `, the wire form; a summary row rewrites the token into that kind's drill; a setting
        // leaves nothing behind and pulses the pill it changed.
        pickMention: (pick: QuickPick): void => {
            const mention = activeMention.value;
            if (mention === undefined) {
                return;
            }
            if (pick.kind === `file` || pick.kind === `drill`) {
                const result = replaceMention(
                    draft.value,
                    mention,
                    caret.value,
                    pick.kind === `file` ? fileMention(pick.path) : drillMention(pick.into),
                );
                applyDraftEdit(result.text, result.caret);
                return;
            }
            const control = applyQuickPick(host.view.conversation.value, pick, host.pickPersona);
            const result = replaceMention(draft.value, mention, caret.value, ``);
            applyDraftEdit(result.text, result.caret);
            if (control !== undefined) {
                flash(control);
            }
        },
        pickCommand: (name: string): void => {
            const rest = draft.value.slice(caret.value);
            const inserted = `/${name} `;
            applyDraftEdit(`${inserted}${rest.startsWith(` `) ? rest.slice(1) : rest}`, inserted.length);
        },
        // A recalled message is complete, so autocomplete mustn't reopen over it: dismissed on the next tick.
        recallInto: (text: string): void => {
            applyDraftEdit(text, text.length);
            void nextTick(() => {
                popoverDismissed.value = true;
            });
        },
    };
};

export type ComposerPopovers = ReturnType<typeof useComposerPopovers>;
