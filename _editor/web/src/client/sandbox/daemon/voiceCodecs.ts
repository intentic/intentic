import { sandboxRef } from "@intentic/extension-api";

// The codings the active daemon's voice sockets speak besides PCM, off its /events hello's `voiceCodecs`. Empty until a
// hello names them, which is also every daemon from before the field and one whose Opus binding did not load: those are
// sent PCM and send PCM. Sandbox-scoped like the route list beside it.
const advertised = sandboxRef<readonly string[]>(() => []);

// Called on every hello frame.
export const setVoiceCodecs = (codecs: readonly string[] | undefined): void => {
    advertised.value = codecs ?? [];
};

// Whether the active daemon's voice sockets speak Opus when asked (`codec=opus`).
export const daemonSpeaksOpus = (): boolean => advertised.value.includes(`opus`);
