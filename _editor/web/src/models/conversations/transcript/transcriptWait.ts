import type { InjectionKey } from "vue";

// Provided `true` by a host whose transcript waits should be one line rather than an outline of turns
// (ChatTranscriptSkeleton): /agents/:id, the phone's chat screen. There the remembered turns were never worth what they
// cost: an imprint retaken every time a streaming turn settles, and up to a page of bars to draw and throw away on
// each open. A host that provides nothing keeps the outline.
export const QUIET_TRANSCRIPT_WAIT: InjectionKey<boolean> = Symbol(`quietTranscriptWait`);
