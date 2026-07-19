use intentic_desktop_core::progress::{ProgressEvent, Reporter};
use tauri::{AppHandle, Emitter};

/// Relays core progress onto the launcher window's event bus.
pub struct EventReporter(pub AppHandle);

pub const PROGRESS_EVENT: &str = "desktop://progress";

impl Reporter for EventReporter {
    fn event(&self, event: ProgressEvent) {
        let _ = self.0.emit(PROGRESS_EVENT, &event);
    }
}
