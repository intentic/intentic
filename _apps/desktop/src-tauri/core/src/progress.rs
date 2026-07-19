use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProgressState {
    Started,
    Log,
    Percent,
    Done,
    Failed,
}

/// One line of the live setup/fix timeline. `stage` groups events (one visual row per stage);
/// `message` is the human line under it; `percent` drives a bar when a download knows its size.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub stage: String,
    pub label: String,
    pub state: ProgressState,
    pub message: Option<String>,
    pub percent: Option<f32>,
}

pub trait Reporter: Send + Sync {
    fn event(&self, event: ProgressEvent);

    fn started(&self, stage: &str, label: &str) {
        self.event(ProgressEvent {
            stage: stage.into(),
            label: label.into(),
            state: ProgressState::Started,
            message: None,
            percent: None,
        });
    }

    fn log(&self, stage: &str, message: &str) {
        self.event(ProgressEvent {
            stage: stage.into(),
            label: String::new(),
            state: ProgressState::Log,
            message: Some(message.into()),
            percent: None,
        });
    }

    fn percent(&self, stage: &str, percent: f32, message: &str) {
        self.event(ProgressEvent {
            stage: stage.into(),
            label: String::new(),
            state: ProgressState::Percent,
            message: Some(message.into()),
            percent: Some(percent),
        });
    }

    fn done(&self, stage: &str) {
        self.event(ProgressEvent {
            stage: stage.into(),
            label: String::new(),
            state: ProgressState::Done,
            message: None,
            percent: None,
        });
    }

    fn failed(&self, stage: &str, message: &str) {
        self.event(ProgressEvent {
            stage: stage.into(),
            label: String::new(),
            state: ProgressState::Failed,
            message: Some(message.into()),
            percent: None,
        });
    }
}

/// Reporter for tests and headless calls.
pub struct NullReporter;

impl Reporter for NullReporter {
    fn event(&self, _event: ProgressEvent) {}
}
