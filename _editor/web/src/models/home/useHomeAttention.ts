import { onScopeDispose, shallowRef, watch } from "vue";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { onScreen } from "../../workbench/window/onScreen";
import { mergeAttention, type AttentionReading } from "./homeFacts";

// Mounted by the home surface only: leaving it stops ambient calls to other sandboxes.
export function useHomeAttention() {
    const { sandboxes } = useSandbox();
    const readings = shallowRef<ReadonlyMap<string, AttentionReading>>(new Map());
    const pending = new Set<string>();
    let disposed = false;
    const poll = (): void => {
        if (!onScreen.value) {
            return;
        }
        for (const box of sandboxes.value) {
            if (pending.has(box.id)) {
                continue;
            }
            pending.add(box.id);
            void sandboxRpc.agents
                .attentionMine(undefined, { context: { at: box.id, background: true } })
                .then(
                    (answer) => update(box.id, answer.needsYou),
                    () => update(box.id, undefined),
                )
                .finally(() => pending.delete(box.id));
        }
    };
    const update = (id: string, count: number | undefined): void => {
        if (!disposed) {
            readings.value = new Map(readings.value).set(id, mergeAttention(readings.value.get(id), count));
        }
    };
    watch(() => [onScreen.value, sandboxes.value.map((box) => box.id)], poll, { immediate: true });
    const timer = setInterval(poll, 15_000);
    onScopeDispose(() => {
        disposed = true;
        clearInterval(timer);
    });
    return readings;
}
