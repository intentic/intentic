import type { RequestField } from "@intentic/sandbox-contract/events/transcript";
import { loadChunk } from "@intentic/ui/chunk";
import { type Component, defineAsyncComponent } from "vue";
import ChatBrowserHelpCard from "./ChatBrowserHelpCard.vue";
import ChatCapabilityCard from "./ChatCapabilityCard.vue";
import ChatCredentialCard from "./ChatCredentialCard.vue";
import ChatPaymentCard from "./ChatPaymentCard.vue";
import ChatPermissionCard from "./ChatPermissionCard.vue";
import ChatPlanCard from "./ChatPlanCard.vue";
import ChatQuestionCard from "./ChatQuestionCard.vue";
import ChatTerminalHelpCard from "./ChatTerminalHelpCard.vue";

// The card each request field is drawn as, as cardReplies' FIELD_OF names the answers: where it was asked
// (ChatMessageView), and in the dock above the composer while it waits (ChatAskDock). Each takes the row, whether an
// answer is on its way, and the one reply every answer goes through.
// The page card is loaded the first time a chat draws one, since most never do and the sealed document builder behind a
// page is not small.
export const CARDS = {
    plan: ChatPlanCard,
    question: ChatQuestionCard,
    permission: ChatPermissionCard,
    browserHelp: ChatBrowserHelpCard,
    terminalHelp: ChatTerminalHelpCard,
    capabilityOffer: ChatCapabilityCard,
    paymentOffer: ChatPaymentCard,
    credentialOffer: ChatCredentialCard,
    pageAsk: defineAsyncComponent(() => loadChunk(() => import(`../pages/ChatPageAskCard.vue`))),
} as const satisfies Record<RequestField, Component>;
