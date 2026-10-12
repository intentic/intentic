import { computed, onScopeDispose, readonly, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

// A typed value once typing has paused: a search field becomes one request per burst of keystrokes rather than one per
// key. One rule for every field that does this, where each used to keep its own timer:
// - it starts out holding the source's value as it is, so a field opened already filled asks about it at once rather
//   than one delay in;
// - with `trim`, the value is trimmed before anything else, so whitespace typed or deleted around the words neither
//   restarts the wait nor spends a request on the same words;
// - the wait dies with the owning scope, so a surface closed mid-type never fires a search after it is gone.

export interface SettledOptions {
    readonly trim?: boolean;
}

export const useSettled = (source: MaybeRefOrGetter<string>, ms: number, { trim = false }: SettledOptions = {}): Readonly<Ref<string>> => {
    const typed = computed(() => (trim ? toValue(source).trim() : toValue(source)));
    const settled = ref(typed.value);
    let timer: ReturnType<typeof setTimeout> | undefined;
    watch(typed, (value) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            settled.value = value;
        }, ms);
    });
    onScopeDispose(() => clearTimeout(timer), true);
    return readonly(settled);
};
