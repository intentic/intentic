import { turnActive } from "../../checkpoints/agent-steering.js";
import { watchProjection } from "../../verification/watch-state.js";
import { turnRunOf } from "./turn-runs.js";

/** Whether a conversation has work in flight: a live turn, or an armed watch it is waiting on. */
export const conversationBusy = (conversationId: string): boolean =>
    turnActive(conversationId) || turnRunOf(conversationId)?.done === false || (watchProjection.of(conversationId) ?? []).length > 0;
