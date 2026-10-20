//! The cards a transcript row can carry: a turn parked on a person (a plan to approve, a question, a permission, a
//! hand-over, an offer, a page to answer). The contract gives each kind its own row field and its own status enum;
//! here every kind shares one [`Card`], with what an answer and the board need typed (its request id and where its
//! decision stands) and the rest kept whole until the app draws that kind natively.

use super::lenient::open_enum;
use serde::{Deserialize, Serialize};

/// Which card, named as the row's field is (`TranscriptRow::card`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CardKind {
    Plan,
    Question,
    Permission,
    BrowserHelp,
    TerminalHelp,
    CapabilityOffer,
    PaymentOffer,
    CredentialOffer,
    PageAsk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// What an answer names (`act::Reply`).
    pub request_id: String,
    pub status: CardStatus,
    /// The rest of the card as the daemon sent it: a plan's text and document, a question's questions and the picks
    /// that answered them, a permission's tool and program, an offer's terms and receipt.
    #[serde(flatten)]
    pub payload: serde_json::Map<String, serde_json::Value>,
}

impl Card {
    /// A string field of the payload, for the few a list row shows before the card is opened (a plan's `text`, a
    /// permission's `toolName` and `title`).
    pub fn text(&self, field: &str) -> Option<&str> {
        self.payload.get(field)?.as_str()
    }
}

open_enum! {
    /// Where a card's decision stands: every kind's statuses in one set, since a reader asks the same thing of each
    /// (is it still waiting, and if not, how did it end). `cancelled` means nobody answered, not a decision.
    pub enum CardStatus {
        Pending = "pending",
        /// A plan or an offer said yes to.
        Approved = "approved",
        /// A plan said no to.
        Rejected = "rejected",
        Cancelled = "cancelled",
        /// A question or a page answered.
        Answered = "answered",
        /// A permission allowed once, for the conversation (`always`), or with everything else it asks (`everything`).
        Allowed = "allowed",
        Always = "always",
        Everything = "everything",
        Denied = "denied",
        /// A hand-over a person cleared, or declined.
        Helped = "helped",
        Declined = "declined",
        /// An offer passed over.
        Skipped = "skipped",
        /// A capability said yes to, still being set up.
        Connecting = "connecting",
    }
}

impl CardStatus {
    /// Still holding its turn open on a person.
    pub fn is_pending(&self) -> bool {
        *self == CardStatus::Pending
    }
}
