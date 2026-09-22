import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { floatingOwner, floatingWindowPanel, showsPanel } from "../../../shell/window/floating";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { type ChatNote, onChatNote, postChatNote } from "./chatChannel";
import { traceFocus } from "./focusTrace";
import { type DraftPreviews, NO_PREVIEWS } from "../drafts/draftPreview";
import { EMPTY_STRIP, type Strip } from "../tabs/tabFacts";

const { activeSandboxId } = useSandbox();
const owner = floatingOwner(`chat`);
export const drawsChat: ComputedRef<boolean> = showsPanel(`chat`);
const heard = shallowRef<Extract<ChatNote, { kind: `strip` }>>();

// A snapshot belongs to one owner incarnation; a replacement cannot inherit its predecessor's projection.
export const elsewhereStrip: ComputedRef<Strip> = computed(() =>
    !drawsChat.value && heard.value?.owner === owner.value ? (heard.value?.strip ?? EMPTY_STRIP) : EMPTY_STRIP,
);

// Composer words for the same tabs, held apart from the strip because they move per character: a window that is
// only listening rebuilds nothing when they land. Unowned and unrevisioned — the strip decides which cards have
// unsent words at all, so a preview no card asks about is never drawn.
const heardPreviews = shallowRef<DraftPreviews>(NO_PREVIEWS);

export const elsewherePreviews: ComputedRef<DraftPreviews> = computed(() => (drawsChat.value ? NO_PREVIEWS : heardPreviews.value));

let published: { sandbox: string | undefined; strip: Strip; revision: number } | undefined;
let publishedPreviews: { sandbox: string | undefined; previews: DraftPreviews } | undefined;
let revision = 0;

// This window is the one drawing the chat, and what it last published describes the sandbox it is still pointed at.
const speaks = (sandbox: string | undefined): boolean =>
    floatingWindowPanel.value === `chat` && owner.value !== undefined && sandbox === activeSandboxId.value;

const speakStrip = (): void => {
    const holder = owner.value;
    if (holder === undefined || published === undefined || !speaks(published.sandbox)) {
        return;
    }
    postChatNote({ kind: `strip`, owner: holder, revision: published.revision, strip: published.strip });
};

const speakPreviews = (): void => {
    if (publishedPreviews === undefined || !speaks(publishedPreviews.sandbox)) {
        return;
    }
    postChatNote({ kind: `previews`, previews: publishedPreviews.previews });
};

const speak = (): void => {
    speakStrip();
    speakPreviews();
};

// The tab store supplies its restored scope; reading the selected sandbox here could mislabel outgoing state.
export const publishStrip = (strip: Strip, sandbox: string | undefined): void => {
    published = { sandbox, strip, revision: ++revision };
    speakStrip();
};

export const publishPreviews = (previews: DraftPreviews, sandbox: string | undefined): void => {
    publishedPreviews = { sandbox, previews };
    speakPreviews();
};

const reconcile = (): void => {
    if (floatingWindowPanel.value === `chat`) {
        speak();
        return;
    }
    postChatNote({ kind: `roll` });
};

onChatNote(`roll`, speak);
onChatNote(`previews`, (note) => {
    if (!drawsChat.value) {
        heardPreviews.value = note.previews;
    }
});
onChatNote(`strip`, (note) => {
    if (drawsChat.value || note.owner !== owner.value || (heard.value?.owner === note.owner && note.revision <= heard.value.revision)) {
        return;
    }
    heard.value = note;
});

watch(
    [activeSandboxId, owner],
    ([sandbox, holder]) => {
        heard.value = undefined;
        heardPreviews.value = NO_PREVIEWS;
        traceFocus(`chat-owner`, { sandbox, owner: holder, draws: drawsChat.value });
    },
    { flush: `sync` },
);

// Post-flush answers must include tab restoration and pane reconciliation from the same ownership change.
watch([activeSandboxId, owner], reconcile, { immediate: true, flush: `post` });

if (typeof window !== `undefined`) {
    window.addEventListener(`focus`, reconcile);
    window.addEventListener(`pageshow`, reconcile);
    document.addEventListener(`visibilitychange`, () => {
        if (document.visibilityState === `visible`) {
            reconcile();
        }
    });
    // Delivery is transient: a missed startup, scope-switch, or resume message must heal without another edit.
    setInterval(() => {
        if (!drawsChat.value) {
            reconcile();
        }
    }, 2_500);
}

reloadOnHotUpdate(import.meta);
