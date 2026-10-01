import { ref } from "vue";

// Whether this window is open on a sandbox without the platform (directMode.ts): set when the reader opens one from
// the outage screen, cleared the moment the platform answers a session check. A module of its own, imported by both
// the auth store and the sandbox store, which import each other's neighbours and so cannot import each other.
// allow(module-state): one window is either on the platform or open directly, never both
export const directMode = ref(false);
