import type { CardStatus } from "./ChatCard.vue";
import type {
    BrowserHelpRequest,
    CapabilityOfferRequest,
    PaymentOfferRequest,
    PermissionRequest,
    PlanRequest,
    QuestionRequest,
    ServiceOfferRequest,
    TerminalHelpRequest,
} from "../composables/chat/transcript.js";

/* HOW EACH DECISION CARD SAYS IT IS OVER, in one place instead of eight.
 *
 * Every one of these was a chain of three or four `v-if` spans inside ChatMessageView's template, each
 * restating the same two class strings and the same two glyphs. That is the shape a rule drifts in: the chips
 * were already three different sizes across the eight cards by the time this was written, and nothing in a
 * template makes such a chain testable.
 *
 * `undefined` means STILL LIVE, and it is what the shell reads to decide whether to draw a chip at all.
 *
 * The tone is not decoration. `done` is "the thing happened" and `gone` is "it did not", which is why a
 * DENIED permission is `gone` and an ALWAYS-allowed one is `done`, and why a cancelled card of any kind is
 * `gone`: a turn that died under a card is not a decision anybody made.
 */

export const planStatus = (plan: PlanRequest): CardStatus | undefined => {
    switch (plan.status) {
        case "approved":
            return { label: "Approved", tone: "done" };
        case "rejected":
            return { label: "Kept planning", tone: "gone" };
        case "cancelled":
            return { label: "Stopped", tone: "gone" };
        default:
            return undefined;
    }
};

export const questionStatus = (question: QuestionRequest): CardStatus | undefined => {
    switch (question.status) {
        case "answered":
            return { label: "Answered", tone: "done" };
        case "cancelled":
            return { label: "Dismissed", tone: "gone" };
        default:
            return undefined;
    }
};

export const permissionStatus = (permission: PermissionRequest): CardStatus | undefined => {
    switch (permission.status) {
        case "allowed":
            return { label: "Allowed", tone: "done" };
        // An always-allow is still a yes, and the card says which yes it was: the grant lasts the rest of the
        // turn, so a reader scrolling back needs to know why the next command like it never asked.
        case "always":
            return { label: "Always allowed", tone: "done" };
        case "denied":
            return { label: "Denied", tone: "gone" };
        case "cancelled":
            return { label: "Stopped", tone: "gone" };
        default:
            return undefined;
    }
};

// The two help asks are one card twice over, so they are one function: the browser's captcha and the
// terminal's waiting prompt differ in where the user goes, not in how the ask ends.
export const helpStatus = (help: BrowserHelpRequest | TerminalHelpRequest): CardStatus | undefined => {
    switch (help.status) {
        case "helped":
            return { label: "You helped", tone: "done" };
        case "declined":
            return { label: "Couldn't help", tone: "gone" };
        case "cancelled":
            return { label: "Stopped", tone: "gone" };
        default:
            return undefined;
    }
};

// The two spend cards, likewise one shape: approved, skipped, or nobody answered. Whether the money actually
// moved is the receipt's to say, in its own row, not the header chip's.
export const offerStatus = (offer: ServiceOfferRequest | PaymentOfferRequest): CardStatus | undefined => {
    switch (offer.status) {
        case "approved":
            return { label: "Approved", tone: "done" };
        case "skipped":
            return { label: "Skipped", tone: "gone" };
        case "cancelled":
            return { label: "Not answered", tone: "gone" };
        default:
            return undefined;
    }
};

/* The capability ask is the one card whose ending is not its own decision: saying yes only starts the setup,
 * which happens on another page and reports back through the outcome frame. So the OUTCOME is read first when
 * there is one, and `connecting` deliberately produces no chip — the card is not finished, it is waiting, and
 * its own body row says so with a spinner. */
export const capabilityStatus = (offer: CapabilityOfferRequest): CardStatus | undefined => {
    if (offer.outcome) {
        return offer.outcome.outcome === "connected" ? { label: "Connected", tone: "done" } : { label: "Setup didn't finish", tone: "gone" };
    }
    switch (offer.status) {
        case "skipped":
            return { label: "Skipped", tone: "gone" };
        case "cancelled":
            return { label: "Not answered", tone: "gone" };
        default:
            return undefined;
    }
};
