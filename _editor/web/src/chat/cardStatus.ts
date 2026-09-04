import type { CardStatus } from "./ChatCard.vue";
import type {
    TranscriptBrowserHelp,
    TranscriptCapabilityOffer,
    TranscriptCredentialOffer,
    TranscriptPaymentOffer,
    TranscriptPermission,
    TranscriptPlan,
    TranscriptQuestion,
    TranscriptServiceOffer,
    TranscriptTerminalHelp,
} from "@intentic/sandbox-contract";

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

export const planStatus = (plan: TranscriptPlan): CardStatus | undefined => {
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

export const questionStatus = (question: TranscriptQuestion): CardStatus | undefined => {
    switch (question.status) {
        case "answered":
            return { label: "Answered", tone: "done" };
        case "cancelled":
            return { label: "Dismissed", tone: "gone" };
        default:
            return undefined;
    }
};

export const permissionStatus = (permission: TranscriptPermission): CardStatus | undefined => {
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
export const helpStatus = (help: TranscriptBrowserHelp | TranscriptTerminalHelp): CardStatus | undefined => {
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

/* The two spend cards and the credential release, one shape: approved, skipped, or nobody answered. Whether
 * the money actually moved — or WHO released the credential — is the receipt's to say, in its own row, not the
 * header chip's. The credential card joins them rather than getting a fourth copy of this switch because its
 * three endings are the same three, and the one thing that makes it different (it is addressed to named
 * people) changes who may press the buttons, not how the card reads once somebody has. */
export const offerStatus = (offer: TranscriptServiceOffer | TranscriptPaymentOffer | TranscriptCredentialOffer): CardStatus | undefined => {
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

/* WHAT A RELEASE IS ACTUALLY FOR, in the reader's words rather than the daemon's lane name.
 *
 * The approver is being asked to make one decision, and the thing that decides it is what happens NEXT: a
 * password about to be typed into a page is a different risk from an account about to be loaded for a turn,
 * and "lane: browser" says neither. So the sentence names the destination in the terms somebody who does not
 * work on this daemon would use.
 *
 * Here rather than in the template because it is a rule with five branches and one of them depends on the
 * KIND as well: a `session` release of a secret cannot happen (secrets are spent at exits, never mounted), so
 * the wording keys off the kind where the two could read the same. */
export const credentialLane = (offer: TranscriptCredentialOffer["offer"]): string => {
    switch (offer.lane) {
        case "shell":
            return "The agent is about to use it in a shell command.";
        case "code":
            return "The agent is about to use it in a script it is running.";
        case "browser":
            return "The agent is about to type it into a page.";
        case "otp":
            return "The agent is about to mint a one-time code from it.";
        default:
            return offer.kind === "capability"
                ? "The agent is asking for this connected account to be loaded into the conversation."
                : "The agent is asking to use this credential.";
    }
};

/* The capability ask is the one card whose ending is not its own decision: saying yes only starts the setup,
 * which happens on another page and reports back through the outcome frame. So the OUTCOME is read first when
 * there is one, and `connecting` deliberately produces no chip — the card is not finished, it is waiting, and
 * its own body row says so with a spinner. */
export const capabilityStatus = (offer: TranscriptCapabilityOffer): CardStatus | undefined => {
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
