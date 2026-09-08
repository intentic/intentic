import { ref } from "vue";
import { storedValue } from "../../../lib/browserStorage";

// Which sandbox the browser is pointed at, and the query-key suffix that scopes cached server state to it. Split
// from useSandbox to stay import-light: this touches only vue and localStorage, so anything can depend on it.
// useSandbox owns the rest (the list, the connection, selecting one).

// The key the active sandbox id is persisted under, so a reload keeps the same one selected.
export const ACTIVE_KEY = `intentic.activeSandboxId`;

export const activeSandboxId = ref<string | undefined>(storedValue(ACTIVE_KEY));

// Appends the sandbox id to a query key so cached state is per-sandbox; appended, not prepended, so a bare prefix
// still matches every sandbox (`.every`). Reach it through a queryKeys family, not directly.
export const sandboxKey = (...parts: readonly unknown[]): unknown[] => [...parts, activeSandboxId];
