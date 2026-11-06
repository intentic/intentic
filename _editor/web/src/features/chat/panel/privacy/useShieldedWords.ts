import type { PrivacyShieldedValue } from "@intentic/sandbox-contract/schemas/privacy";
import { keepPreviousData } from "@tanstack/vue-query";
import { tipOnHover } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import type { RenderedMarkdown } from "../../../../lib/markdown/renderMarkdown";
import { markShielded, SHIELDED_ATTRIBUTE } from "./shieldedWords";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { usePrivacyShield } from "../../../../models/sandbox/usePrivacyShield";

// The values in this pane's replies its model never read (shieldedWords.ts), read once per conversation and again each
// time a turn ends, since only a finished reply can hold a new one. Every message of the pane shares the one read. Asked
// only while the shield runs at all; memory only, since the answer is personal data.
const useShieldedWords = (): ComputedRef<readonly PrivacyShieldedValue[]> => {
    const { conversation } = usePaneView();
    const { status } = usePrivacyShield();
    const conversationId = computed(() => conversation.value.conversationId);
    // The transcript's length once no turn runs: part of the key, so a finished turn reads again, and the same for every
    // message whenever it mounted. Not asked while a turn runs; the last answer stands until it ends.
    const settled = computed(() => (conversation.value.turn.streaming.value ? undefined : conversation.value.transcript.messages.value.length));
    const read = rpcQuery(`privacy.shielded`, () => ({ conversationId: conversationId.value }), { unpersisted: true });
    const { query } = useSandboxQuery({
        queryKey: computed(() => [...read.queryKey.value, settled.value ?? `live`]),
        queryFn: read.queryFn,
        enabled: computed(() => settled.value !== undefined && status.value?.policy.mode === `on`),
        placeholderData: keepPreviousData,
        retry: false,
    });
    return computed(() => query.data.value ?? []);
};

// One reply's prose with those values marked, and the hover that says of each what its model read: bound to the reply's
// container as a delegated `mouseover`, since the marks sit in rendered HTML no template owns. `applies` is false for
// what is not a finished reply (a person's words, a notice, a reply still streaming).
export const useShieldedMarks = (body: MaybeRefOrGetter<RenderedMarkdown>, applies: MaybeRefOrGetter<boolean>) => {
    const t = useT();
    const values = useShieldedWords();
    const shown = computed(() => (toValue(applies) ? markShielded(toValue(body), values.value) : toValue(body)));
    const onHover = (event: MouseEvent): void => {
        const mark = event.target instanceof Element ? event.target.closest<HTMLElement>(`[${SHIELDED_ATTRIBUTE}]`) : null;
        const token = mark?.getAttribute(SHIELDED_ATTRIBUTE);
        if (mark === null || mark === undefined || token === null || token === undefined) {
            return;
        }
        tipOnHover(mark, {
            title: t(`chat.shieldedWords.title`),
            rows: [{ label: t(`chat.shieldedWords.read`), value: token }],
            note: t(`chat.shieldedWords.note`),
        });
    };
    return { shown, onHover };
};
