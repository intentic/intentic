//! Acting in a conversation: sending through an outbox kept in the store, steering a running turn, stopping it,
//! answering its card. A message carries its own id, and the daemon answers a second send of an id it already took
//! with what became of the first, so the outbox resends blindly after an outage.

use super::Client;
use super::conversations::row_change;
use crate::bridge::{CardAnswer, Event, OfferKind, Outcome, PermissionDecision};
use crate::conversation::Conversation;
use crate::net::{Auth, HttpError};
use crate::session::SessionError;
use crate::wire::act::{
    Accepted, Decision, MessageReceipt, REPLY, Reply, SEND, STEER, STOP, SendMessage, Steer,
    StopResult, StopTurn,
};
use crate::wire::lenient::True;
use crate::wire::transcript::TranscriptRow;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

/// A message kept until the daemon takes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Outgoing {
    agent: String,
    message_id: String,
    text: String,
    attachments: Vec<String>,
}

fn outbox_key(sandbox: &str) -> String {
    format!("outbox:{sandbox}")
}

/// A random (version 4) UUID, the id shape the web client gives conversations and messages.
pub(crate) fn uuid() -> String {
    let mut bytes = [0u8; 16];
    // A phone with no randomness has bigger problems; all zeros still makes a valid id.
    let _ = SystemRandom::new().fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

impl Client {
    async fn open_sandbox(&self) -> Result<String, SessionError> {
        self.state
            .lock()
            .await
            .open
            .clone()
            .ok_or(SessionError::NoAddress)
    }

    async fn call<O: serde::de::DeserializeOwned>(
        &self,
        sandbox: &str,
        path: &str,
        body: &impl Serialize,
    ) -> Result<O, SessionError> {
        let (base, token) = self.daemon(sandbox).await.ok_or(SessionError::NoAddress)?;
        let answer = self
            .http
            .json::<O>(
                reqwest::Method::POST,
                &format!("{base}{path}"),
                Auth::Bearer(&token),
                &[],
                Some(body),
            )
            .await?;
        Ok(answer.value)
    }

    fn say_rows(&self, agent: &str, held: &Conversation, change: crate::conversation::Change) {
        self.emit(Event::Rows {
            agent: agent.to_owned(),
            count: held.len() as u32,
            change: row_change(change),
            live: held.live(),
            more: held.more(),
        });
    }

    pub(super) async fn send(
        &'static self,
        agent: Option<String>,
        text: String,
        attachments: Vec<String>,
    ) -> Result<Outcome, SessionError> {
        let sandbox = self.open_sandbox().await?;
        let outgoing = Outgoing {
            agent: agent.unwrap_or_else(uuid),
            message_id: uuid(),
            text,
            attachments,
        };
        // Kept before it is tried, so neither an outage nor the app being killed loses it.
        self.stored(|store| {
            let mut outbox: Vec<Outgoing> =
                store.get_json(&outbox_key(&sandbox))?.unwrap_or_default();
            outbox.push(outgoing.clone());
            store.put_json(&outbox_key(&sandbox), &outbox)
        });
        if let Some(rows) = self.conversation(&outgoing.agent)
            && let Ok(mut held) = rows.lock()
        {
            let row: TranscriptRow = serde_json::from_value(serde_json::json!({
                "role": "user",
                "text": outgoing.text,
                "messageId": outgoing.message_id,
                "attachments": outgoing.attachments,
            }))
            .map_err(|error| SessionError::Http(HttpError::Decode(error.to_string())))?;
            let change = held.sent(row);
            self.say_rows(&outgoing.agent, &held, change);
        }
        let agent = outgoing.agent.clone();
        match self.deliver(&sandbox, &outgoing).await {
            Ok(()) => Ok(Outcome::Sent {
                agent,
                queued: false,
            }),
            // The sandbox is unreachable or has no session yet: the link sends it when it is live again.
            Err(
                SessionError::Http(HttpError::Network(_) | HttpError::Idle)
                | SessionError::NoAddress,
            ) => Ok(Outcome::Sent {
                agent,
                queued: true,
            }),
            Err(error) => {
                self.unqueue(&sandbox, &outgoing.message_id);
                Err(error)
            }
        }
    }

    async fn deliver(&self, sandbox: &str, outgoing: &Outgoing) -> Result<(), SessionError> {
        let message = SendMessage {
            prompt: outgoing.text.clone(),
            conversation_id: Some(outgoing.agent.clone()),
            message_id: Some(outgoing.message_id.clone()),
            attachments: (!outgoing.attachments.is_empty()).then(|| outgoing.attachments.clone()),
            ..SendMessage::default()
        };
        let receipt: MessageReceipt = self.call(sandbox, SEND.path, &message).await?;
        self.unqueue(sandbox, &outgoing.message_id);
        if let Some(run) = receipt.run {
            self.run_started(&outgoing.agent, run);
        }
        Ok(())
    }

    fn unqueue(&self, sandbox: &str, message_id: &str) {
        self.stored(|store| {
            let mut outbox: Vec<Outgoing> =
                store.get_json(&outbox_key(sandbox))?.unwrap_or_default();
            outbox.retain(|outgoing| outgoing.message_id != message_id);
            store.put_json(&outbox_key(sandbox), &outbox)
        });
    }

    /// Sends what the outbox kept for `sandbox`, oldest first, stopping at the first that still cannot go.
    pub(super) async fn flush_outbox(&self, sandbox: &str) {
        let outbox: Vec<Outgoing> = self
            .stored(|store| store.get_json(&outbox_key(sandbox)))
            .unwrap_or_default();
        for outgoing in outbox {
            match self.deliver(sandbox, &outgoing).await {
                Ok(()) => {}
                Err(SessionError::Http(HttpError::Status { status, .. }))
                    if (400..500).contains(&status) =>
                {
                    // Refused for good (a 4xx), not lost to an outage: holding it would block the rest forever.
                    log::warn!("the outbox dropped a message the sandbox refused ({status})");
                    self.unqueue(sandbox, &outgoing.message_id);
                }
                Err(error) => {
                    log::info!("the outbox waits: {error}");
                    return;
                }
            }
        }
    }

    pub(super) async fn steer(
        &'static self,
        agent: String,
        text: String,
    ) -> Result<Outcome, SessionError> {
        let sandbox = self.open_sandbox().await?;
        let steer = Steer {
            conversation_id: agent.clone(),
            text: text.clone(),
            message_id: Some(uuid()),
            ..Steer::default()
        };
        match self
            .call::<MessageReceipt>(&sandbox, STEER.path, &steer)
            .await
        {
            Ok(_) => Ok(Outcome::Done),
            // Nothing running to steer: it is a message, then.
            Err(SessionError::Http(HttpError::Status { status: 404, .. })) => {
                self.send(Some(agent), text, Vec::new()).await
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn stop(&self, agent: String) -> Result<Outcome, SessionError> {
        let sandbox = self.open_sandbox().await?;
        let run = self.conversation(&agent).and_then(|rows| {
            rows.lock()
                .ok()
                .and_then(|held| held.run().map(str::to_owned))
        });
        let stop = match run {
            Some(run) => StopTurn::Run {
                conversation_id: agent,
                run,
            },
            None => StopTurn::Live {
                conversation_id: agent,
                live: True,
            },
        };
        let _: StopResult = self.call(&sandbox, STOP.path, &stop).await?;
        Ok(Outcome::Done)
    }

    pub(super) async fn answer(&self, answer: CardAnswer) -> Result<Outcome, SessionError> {
        let sandbox = self.open_sandbox().await?;
        let _: Accepted = self.call(&sandbox, REPLY.path, &reply(answer)).await?;
        Ok(Outcome::Done)
    }
}

fn reply(answer: CardAnswer) -> Reply {
    match answer {
        CardAnswer::Plan {
            request_id,
            approve,
            feedback,
        } => Reply::Plan {
            request_id,
            approve,
            feedback,
        },
        CardAnswer::Question {
            request_id,
            answers,
            cancelled,
        } => Reply::Question {
            request_id,
            answers: (!cancelled).then(|| answers.into_iter().collect()),
            attachments: None,
            cancelled: cancelled.then_some(true),
        },
        CardAnswer::Permission {
            request_id,
            decision,
        } => Reply::Permission {
            request_id,
            decision: match decision {
                PermissionDecision::Once => Decision::Once,
                PermissionDecision::Always => Decision::Always,
                PermissionDecision::Everything => Decision::Everything,
                PermissionDecision::Deny => Decision::Deny,
            },
            feedback: None,
            child: None,
        },
        CardAnswer::Help {
            request_id,
            terminal: false,
            helped,
        } => Reply::BrowserHelp {
            request_id,
            helped,
            note: None,
        },
        CardAnswer::Help {
            request_id,
            terminal: true,
            helped,
        } => Reply::TerminalHelp {
            request_id,
            helped,
            note: None,
        },
        CardAnswer::Offer {
            request_id,
            offer: OfferKind::Capability,
            accept,
        } => Reply::CapabilityOffer {
            request_id,
            connect: accept,
        },
        CardAnswer::Offer {
            request_id,
            offer: OfferKind::Payment,
            accept,
        } => Reply::PaymentOffer {
            request_id,
            approve: accept,
        },
        CardAnswer::Offer {
            request_id,
            offer: OfferKind::Credential,
            accept,
        } => Reply::CredentialOffer {
            request_id,
            approve: accept,
        },
        CardAnswer::Page {
            request_id,
            value,
            cancelled,
        } => Reply::PageAsk {
            request_id,
            value,
            cancelled: cancelled.then_some(true),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mints_version_4_uuids() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(id, uuid());
    }

    #[test]
    fn answers_a_question_card_in_the_contracts_shape() {
        let answer = CardAnswer::Question {
            request_id: "q1".into(),
            answers: [("Which?".to_owned(), vec!["A".to_owned()])].into(),
            cancelled: false,
        };
        assert_eq!(
            serde_json::to_value(reply(answer)).unwrap(),
            serde_json::json!({"kind": "question", "requestId": "q1", "answers": {"Which?": ["A"]}})
        );
    }
}
