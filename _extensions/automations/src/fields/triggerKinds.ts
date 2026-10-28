import type { IconName } from "@intentic/extension-ui";
import { computed } from "vue";
import type { AutomationFormState, TriggerKind } from "../useAutomationForm";
import { t } from "../i18n.js";

// WHAT WAKES IT, as a choice: the kinds on offer, the one sentence under the choice, and the choice itself, which also
// picks a connected source when it turns to Live. Shared by the full form and the draft's When panel.
export const useTriggerKinds = (state: AutomationFormState) => {
    const { form, liveSources, isVisitorChat, listenerSource } = state;
    // The app's segmented control, not four hand-drawn cards, so the loudest thing in the form isn't the trigger-kind
    // question. Each keeps its glyph, the same one the list outside this form uses for the row.
    const TRIGGER_TABS = computed<readonly { value: TriggerKind; label: string; icon: IconName }[]>(() => [
        { value: `schedule`, label: t(`automationFields.schedule`), icon: `clock` },
        { value: `once`, label: t(`automationFields.once`), icon: `pin` },
        { value: `event`, label: t(`automationFields.webhook`), icon: `bolt` },
        // Needs a connected gateway; an already-Live automation keeps it listed so its editor can't re-point it.
        ...(liveSources.value.length > 0 || form.kind === `listener`
            ? [{ value: `listener` as const, label: t(`automationFields.live`), icon: `wifi` as const }]
            : []),
        { value: `workspace`, label: t(`automationFields.workspace`), icon: `eye` },
    ]);

    // One caption sentence per trigger kind, shown under the picker instead of a label with its own gloss.
    // Built when read, so the caption follows the language on screen.
    const kindCaption = (kind: TriggerKind): string =>
        ({
            schedule: t(`automationFields.kindCaption.schedule`),
            // Says the two things a reminder's owner has to know and cannot see: which clock the time was read on, and that a
            // sleeping sandbox delivers late rather than never.
            once: t(`automationFields.kindCaption.once`),
            event: t(`automationFields.kindCaption.event`),
            listener: t(`automationFields.kindCaption.listener`),
            workspace: t(`automationFields.kindCaption.workspace`),
        })[kind];
    // Names the source directly, not "a connected service", since the reader just picked it; a Visitor chat isn't a service,
    // so it says what actually happens.
    const whenCaption = computed<string>(() => {
        if (form.kind !== `listener`) {
            return kindCaption(form.kind);
        }
        return isVisitorChat.value
            ? t(`automationFields.kindCaption.visitorChat`)
            : t(`automationFields.kindCaption.source`, { source: listenerSource.value.label });
    });

    // Wrapped, not bound straight to `form.kind`: switching to Live also has to pick a connected source.
    const kind = computed<TriggerKind>({
        get: () => form.kind,
        set: (next) => {
            form.kind = next;
            if (next === `listener` && !liveSources.value.some((source) => source.provider === form.provider)) {
                form.provider = liveSources.value[0]?.provider ?? `discord`;
            }
        },
    });
    return { TRIGGER_TABS, whenCaption, kind };
};
