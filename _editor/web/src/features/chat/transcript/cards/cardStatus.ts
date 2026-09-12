import type { CardStatus } from "./ChatCard.vue";
import type {
    TranscriptBrowserHelp,
    TranscriptCapabilityOffer,
    TranscriptCredentialOffer,
    TranscriptPaymentOffer,
    TranscriptPermission,
    TranscriptPlan,
    TranscriptQuestion,
    TranscriptTerminalHelp,
} from "@intentic/sandbox-contract";

// How each decision card signals it is over, replacing per-card v-if chains in ChatMessageView. `undefined` means still
// live. `done` means the thing happened, `gone` means it didn't: a denied permission and any cancelled card are `gone`,
// an always-allowed one is `done`.

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
        // An always-allow still counts as a yes; the grant lasts the rest of the turn without asking again.
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

// Browser captcha and terminal waiting prompt differ only in where the user goes, not in how the ask ends; one function
// covers both.
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

// Payment and credential release share the same three endings; whether money moved or who released it is the receipt's
// to say, not this chip. Credential differs only in who may press the buttons.
export const offerStatus = (offer: TranscriptPaymentOffer | TranscriptCredentialOffer): CardStatus | undefined => {
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

// Names the destination in the reader's terms, since the risk depends on where the credential is going, not the lane
// name. Also keys off `kind`: a `session` release of a secret can't happen, secrets are only spent at exits.
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

// Saying yes only starts setup elsewhere, so the outcome frame is read first when present. `connecting` produces no
// chip: the card isn't finished, it's waiting, and its own row shows a spinner.
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
