import { onScopeDispose, shallowRef, watch } from "vue";
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

// What each sandbox holds for its reader, as Home's tiles count it. Mounted by Home's rail and by the sandbox rail's
// door to Home: unmounting stops the ambient calls to other sandboxes.
export function useHomeAttention({ everyMs = 15_000, skip = () => undefined }: AttentionPace = {}) {
    const { sandboxes } = useSandbox();
    const readings = shallowRef<ReadonlyMap<string, AttentionReading>>(new Map());
    const pending = new Set<string>();
    let disposed = false;
    const asked = () => switchableSandboxes(sandboxes.value).filter((box) => box.id !== skip());
    const poll = (): void => {
        if (!onScreen.value) {
            return;
        }
        // The rail's own tiles: a row with no daemon behind it has nobody to ask.
        for (const box of asked()) {
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
    watch(() => [onScreen.value, asked().map((box) => box.id)], poll, { immediate: true });
    const timer = setInterval(poll, everyMs);
    onScopeDispose(() => {
        disposed = true;
        clearInterval(timer);
    });
    return readings;
}
