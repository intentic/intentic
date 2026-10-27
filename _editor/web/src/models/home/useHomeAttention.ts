import type { SandboxSummary } from "@intentic/api-contract";
import { computed, onScopeDispose, type Ref, shallowRef, watch } from "vue";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { onScreen } from "../../workbench/window/onScreen";
import { switchableSandboxes } from "../sandbox/live/roster";
import { mergeAttention, type AttentionReading } from "./homeFacts";

export interface AttentionPace {
    // Between two reads of every box. Home's rail is the page being looked at, so it reads often; the sandbox rail's door
    // to Home (shell/rail/OtherSandboxes.vue) is ambient awareness, and reads at the across-sandboxes store's slow pace.
    readonly everyMs?: number;
    // A box not to ask: the one the shell is inside, whose own tiles already carry its counts.
    readonly skip?: () => string | undefined;
}

export interface AttentionSource {
    readonly sandboxes: Readonly<Ref<readonly SandboxSummary[]>>;
    readonly activeSandboxId: Readonly<Ref<string | undefined>>;
    readonly reachable: Readonly<Ref<boolean>>;
    readonly onScreen: Readonly<Ref<boolean>>;
    readonly read: (id: string) => Promise<{ readonly needsYou: number }>;
}

const attentionSource = (): AttentionSource => {
    const { sandboxes, activeSandboxId, reachable } = useSandbox();
    return {
        sandboxes, activeSandboxId, reachable, onScreen,
        read: (id) => sandboxRpc.agents.attentionMine(undefined, { context: { at: id, background: true } }),
    };
};

// What each sandbox holds for its reader, as Home's tiles count it. Mounted by Home's rail and by the sandbox rail's
// door to Home: unmounting stops the ambient calls to other sandboxes.
export function useHomeAttention({ everyMs = 15_000, skip = () => undefined }: AttentionPace = {}, source: AttentionSource = attentionSource()) {
    const { sandboxes, activeSandboxId, reachable } = source;
    const readings = shallowRef<ReadonlyMap<string, AttentionReading>>(new Map());
    const pending = new Set<string>();
    let disposed = false;
    const asked = () => switchableSandboxes(sandboxes.value).filter((box) => box.id !== skip());
    const read = (id: string): void => {
        if (!source.onScreen.value || pending.has(id)) {
            return;
        }
        pending.add(id);
        void source.read(id)
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
    watch(() => [activeSandboxId.value, reachable.value] as const, ([id, online]) => {
        if (online && asked().some((box) => box.id === id) && id !== undefined) {
            read(id);
        }
    });
    const timer = setInterval(poll, everyMs);
    onScopeDispose(() => {
        disposed = true;
        clearInterval(timer);
    });
    return computed(() => {
        const id = activeSandboxId.value;
        const previous = id === undefined ? undefined : readings.value.get(id);
        // The live connection proves this sandbox is awake, even if an attention read from before the wake fails late.
        // Keep its last count until the refresh answers; other sandboxes still rely on their own polls.
        return id !== undefined && reachable.value && previous?.unreachable === true
            ? new Map(readings.value).set(id, { ...previous, unreachable: false })
            : readings.value;
    });
}
