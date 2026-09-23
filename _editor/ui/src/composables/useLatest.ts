import { onScopeDispose } from "vue";

// A stale-response guard: each `begin()` supersedes every earlier one, and so does the owning scope's end.
export const useLatest = (): (() => () => boolean) => {
    let seq = 0;
    onScopeDispose(() => {
        seq += 1;
    }, true);
    // The check answers whether this begin is still the latest; an answer arriving after it turns false is dropped.
    return () => {
        const id = ++seq;
        return () => id === seq;
    };
};
