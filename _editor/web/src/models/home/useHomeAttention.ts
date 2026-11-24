import type { SandboxSummary } from "@intentic/api-contract";
import { computed, onScopeDispose, type Ref, shallowRef, watch } from "vue";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { sandboxScopeOf } from "../../client/sandbox/scope/useSandboxScope";
import { queryClient } from "../../lib/queryPersistence";
import { onScreen } from "../../workbench/window/onScreen";
import { switchableSandboxes } from "../sandbox/live/roster";
import { mergeAttention, type AttentionReading } from "./homeFacts";
import { ATTENTION_QUERY, ATTENTION_SHARED_MS, attentionKey, attentionRead } from "./useAttentionMine";

export interface AttentionPace {
    // Between two reads of every box. Home's rail is the page being looked at, so it reads often; the sandbox rail's door
    // to Home (shell/rail/OtherSandboxes.vue) is ambient awareness, and reads at the across-sandboxes store's slow pace.
    readonly everyMs?: number;
    // A box not to ask: the one the shell is inside, whose own tiles already carry its counts.
    readonly skip?: () => string | undefined;
}

export interface AttentionSource {
    readonly sandboxes: Readonly<Ref<readonly SandboxSummary[]>>;
    // Whether a live connection proves the sandbox awake (its scope's `reachable`: the active one's, while connected).
    readonly reachable: (id: string) => boolean;
    readonly onScreen: Readonly<Ref<boolean>>;
    // `fresh` asks the daemon again even when another reader of the same entry has just asked.
    readonly read: (id: string, fresh: boolean) => Promise<{ readonly needsYou: number }>;
}

// Each sandbox's read through its scope (client/sandbox/scope), as one cache entry: Home's rail, the sandbox rail's door to
// Home and each tile's badge (useAttentionMine.ts) all read the entry `agents.attentionMine` keys for that sandbox, so a
// read one of them made a moment ago answers the others instead of a second call.
const attentionSource = (): AttentionSource => {
    const { sandboxes } = useSandbox();
    return {
        sandboxes,
        reachable: (id) => sandboxScopeOf(id).reachable.value,
        onScreen,
        read: (id, fresh) => {
            const scope = sandboxScopeOf(id);
            return queryClient.fetchQuery({
                queryKey: attentionKey(scope),
                queryFn: () => attentionRead(scope, fresh),
                staleTime: fresh ? 0 : ATTENTION_SHARED_MS,
                ...ATTENTION_QUERY,
            });
        },
    };
};

// What each sandbox holds for its reader, as Home's tiles count it. Mounted by Home's rail and by the sandbox rail's
// door to Home: unmounting stops the ambient calls to other sandboxes.
export function useHomeAttention({ everyMs = 15_000, skip = () => undefined }: AttentionPace = {}, source: AttentionSource = attentionSource()) {
    const { sandboxes } = source;
    const readings = shallowRef<ReadonlyMap<string, AttentionReading>>(new Map());
    const pending = new Set<string>();
    let disposed = false;
    const asked = () => switchableSandboxes(sandboxes.value).filter((box) => box.id !== skip());
    const read = (id: string, fresh = false): void => {
        if (!source.onScreen.value || pending.has(id)) {
            return;
        }
        pending.add(id);
        void source.read(id, fresh)
            .then(
                (answer) => update(id, answer.needsYou),
                () => update(id, undefined),
            )
            .finally(() => pending.delete(id));
    };
    const poll = (): void => {
        // The rail's own tiles: a row with no daemon behind it has nobody to ask.
        for (const box of asked()) {
            read(box.id);
        }
    };
    const update = (id: string, count: number | undefined): void => {
        if (!disposed) {
            readings.value = new Map(readings.value).set(id, mergeAttention(readings.value.get(id), count));
        }
    };
    watch(() => [source.onScreen.value, asked().map((box) => box.id)], poll, { immediate: true });
    // A sandbox whose connection just came up is read again at once, past whatever another reader cached a moment ago.
    const live = (): string[] => asked().filter((box) => source.reachable(box.id)).map((box) => box.id);
    watch(live, (now, before) => {
        for (const id of now.filter((candidate) => !before.includes(candidate))) {
            read(id, true);
        }
    });
    const timer = setInterval(poll, everyMs);
    onScopeDispose(() => {
        disposed = true;
        clearInterval(timer);
    });
    return computed(() => {
        // A live connection proves its sandbox is awake, even if an attention read from before the wake fails late. Keep
        // its last count until the refresh answers; other sandboxes still rely on their own polls.
        let shown = readings.value;
        for (const [id, previous] of readings.value) {
            if (previous.unreachable && source.reachable(id)) {
                shown = new Map(shown).set(id, { ...previous, unreachable: false });
            }
        }
        return shown;
    });
}
