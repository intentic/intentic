import { computed, type ComputedRef, shallowRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { floatingOwner, floatingWindowPanel, showsPanel } from "../../../shell/window/floating";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { type ChatNote, onChatNote, postChatNote } from "./chatChannel";
import { traceFocus } from "./focusTrace";
import { EMPTY_STRIP, type Strip } from "../tabs/tabFacts";

const { activeSandboxId } = useSandbox();
const owner = floatingOwner(`chat`);
export const drawsChat: ComputedRef<boolean> = showsPanel(`chat`);
const heard = shallowRef<Extract<ChatNote, { kind: `strip` }>>();

// A snapshot belongs to one owner incarnation; a replacement cannot inherit its predecessor's projection.
export const elsewhereStrip: ComputedRef<Strip> = computed(() =>
    !drawsChat.value && heard.value?.owner === owner.value ? (heard.value?.strip ?? EMPTY_STRIP) : EMPTY_STRIP,
);

let published: { sandbox: string | undefined; strip: Strip; revision: number } | undefined;
let revision = 0;

const speak = (): void => {
    if (floatingWindowPanel.value !== `chat` || owner.value === undefined || published === undefined || published.sandbox !== activeSandboxId.value) {
        return;
    }
    postChatNote({ kind: `strip`, owner: owner.value, revision: published.revision, strip: published.strip });
};

// The tab store supplies its restored scope; reading the selected sandbox here could mislabel outgoing state.
export const publishStrip = (strip: Strip, sandbox: string | undefined): void => {
    published = { sandbox, strip, revision: ++revision };
    speak();
};

const reconcile = (): void => {
    if (floatingWindowPanel.value === `chat`) {
        speak();
        return;
    }
    postChatNote({ kind: `roll` });
};

onChatNote(`roll`, speak);
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
