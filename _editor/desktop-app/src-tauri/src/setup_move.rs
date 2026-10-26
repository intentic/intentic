//! THE MOVE A PC'S SETUP CARRIES, READ (2026-10-26). `ic docker prepare` moves this PC's sandboxes off Docker Desktop as
//! its `engine-move` row, in its own process, and prints the same `intentic-move:` lines a move from the engine card does
//! (ic's engine/moves.rs `say`). The setup used to drop them. Its bar sat where the row began for the whole move (50% on a
//! PC with two rows to do, "8 min left" beside it, for minutes), the line above it was ic's English sentence, and only a
//! reload showed the engine card, which knew no more than that a move ran. Folded here into the sandbox in hand, of how
//! many, its step and its bytes, and how far through the row that is (onboarding.rs draws the row with it). Pure.

use serde::Serialize;
use serde_json::Value;

/// A sandbox's share of the row spent stopping it, before its first byte moves.
const STOPPED: f64 = 0.05;
/// Its share spent copying its image and files, measured in bytes. What is left of the share is starting it again on the
/// other engine, a reshape with its health check: on omen about as long as copying a 1.5 GB sandbox's files.
const COPIED: f64 = 0.8;

/// How far the move is, as the setup card draws it (src/device/pcSetup/setupLine.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupMove {
    /// The sandbox in hand, and which of how many (from 0).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// ic's step. Before any sandbox: `source` (Docker Desktop being started to read its sandboxes) or `engine` (Intentic's
    /// engine installed first). Then, each sandbox: `begin`, `stopping`, `image`, `volume`, `starting`, `moved`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// The copy under way: bytes so far, and of how many (ic's estimate, for an image).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// The sandbox's bytes to copy, as `begin` said, and those of its copies already over: its share is measured in them.
    #[serde(skip)]
    bytes: u64,
    #[serde(skip)]
    copied: u64,
}

fn amount(event: &Value, key: &str) -> Option<u64> {
    event.get(key).and_then(Value::as_u64)
}

impl SetupMove {
    /// One `intentic-move:` line, as engine.rs `parse_move_line` reads it. `done` and `failed` end the move, which the
    /// row's own marker says next; anything else ic may add later is left alone.
    pub fn hear(&mut self, event: &Value) {
        let Some(step) = event["step"].as_str() else {
            return;
        };
        match step {
            "begin" => {
                *self = SetupMove {
                    slug: event["slug"].as_str().map(str::to_string),
                    index: amount(event, "index"),
                    count: amount(event, "count"),
                    step: Some(step.to_string()),
                    bytes: amount(event, "bytes").unwrap_or(0),
                    ..SetupMove::default()
                };
            }
            "source" | "engine" | "stopping" | "starting" | "moved" => self.enter(step),
            // A copy's first line names what it copies (and, for files, how much); every line after it says how far.
            "image" | "volume" => match amount(event, "done") {
                None => {
                    self.enter(step);
                    self.total = amount(event, "total").filter(|total| *total > 0);
                }
                Some(done) => {
                    if self.step.as_deref() != Some(step) {
                        self.enter(step);
                    }
                    self.done = Some(done);
                    if let Some(total) = amount(event, "total").filter(|total| *total > 0) {
                        self.total = Some(total);
                    }
                }
            },
            _ => {}
        }
    }

    /// A step of its own: the copy before it, if any, is over and counts toward the sandbox's bytes.
    fn enter(&mut self, step: &str) {
        self.copied = self.copied.saturating_add(self.done.take().unwrap_or(0));
        self.total = None;
        self.step = Some(step.to_string());
    }

    /// How far through the row the move is, 0 to 100. Each sandbox is an equal share, since ic says one's size only as it
    /// begins; within it, a little for stopping it, most of it for its bytes, the rest for starting it again.
    pub fn percent(&self) -> u64 {
        let (Some(index), Some(count)) = (self.index, self.count) else {
            return 0;
        };
        if count == 0 {
            return 0;
        }
        let within = match self.step.as_deref() {
            Some("stopping") => STOPPED,
            Some("image" | "volume") => STOPPED + COPIED * self.copied_share(),
            Some("starting") => STOPPED + COPIED,
            Some("moved") => 1.0,
            _ => 0.0,
        };
        let fraction = ((index as f64 + within) / count as f64).clamp(0.0, 1.0);
        (fraction * 100.0).round() as u64
    }

    fn copied_share(&self) -> f64 {
        if self.bytes == 0 {
            return 0.0;
        }
        let copied = self.copied.saturating_add(self.done.unwrap_or(0));
        (copied as f64 / self.bytes as f64).min(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn heard(lines: &[Value]) -> SetupMove {
        let mut moving = SetupMove::default();
        for line in lines {
            moving.hear(line);
        }
        moving
    }

    #[test]
    fn nothing_has_moved_before_the_first_sandbox_begins() {
        let waiting =
            heard(&[json!({ "slug": "", "step": "source", "starting": "dockerDesktop" })]);
        assert_eq!(waiting.step.as_deref(), Some("source"));
        assert_eq!(waiting.percent(), 0);
        assert_eq!(SetupMove::default().percent(), 0);
    }

    #[test]
    fn the_row_fills_with_the_sandboxes_bytes_and_each_sandbox_is_an_equal_share() {
        let begun =
            json!({ "slug": "work", "step": "begin", "index": 0, "count": 4, "bytes": 1000 });
        assert_eq!(heard(std::slice::from_ref(&begun)).percent(), 0);
        let stopping = json!({ "slug": "work", "step": "stopping", "container": "intentic-work" });
        assert_eq!(heard(&[begun.clone(), stopping.clone()]).percent(), 1);
        // The image (400 bytes), then the files (600): half of the sandbox's bytes is half of its copying share.
        let image = [
            json!({ "slug": "work", "step": "image", "images": ["ghcr.io/intentic/sandbox:stable"] }),
            json!({ "slug": "work", "step": "image", "done": 200, "total": 400 }),
            json!({ "slug": "work", "step": "image", "done": 400, "total": 400 }),
        ];
        let files = [
            json!({ "slug": "work", "step": "volume", "volume": "work-data", "total": 600 }),
            json!({ "slug": "work", "step": "volume", "done": 100, "total": 600 }),
        ];
        let mut lines = vec![begun, stopping];
        lines.extend(image.iter().cloned());
        lines.extend(files.iter().cloned());
        let copying = heard(&lines);
        assert_eq!(copying.step.as_deref(), Some("volume"));
        assert_eq!((copying.done, copying.total), (Some(100), Some(600)));
        // (0.05 + 0.8 × 500/1000) / 4
        assert_eq!(copying.percent(), 11);
        lines.push(json!({ "slug": "work", "step": "starting" }));
        let starting = heard(&lines);
        assert_eq!((starting.done, starting.total), (None, None));
        assert_eq!(starting.percent(), 21);
        lines.push(json!({ "slug": "work", "step": "moved" }));
        assert_eq!(heard(&lines).percent(), 25);
        // The last sandbox starts its own share from where the ones before it left the row.
        lines
            .push(json!({ "slug": "notes", "step": "begin", "index": 3, "count": 4, "bytes": 50 }));
        let next = heard(&lines);
        assert_eq!(next.slug.as_deref(), Some("notes"));
        assert_eq!(next.percent(), 75);
        lines.push(json!({ "slug": "notes", "step": "moved" }));
        assert_eq!(heard(&lines).percent(), 100);
    }

    #[test]
    fn a_sandbox_with_nothing_to_copy_moves_on_its_steps_alone() {
        let lines = [
            json!({ "slug": "work", "step": "begin", "index": 0, "count": 1, "bytes": 0 }),
            json!({ "slug": "work", "step": "volume", "volume": "work-data", "total": 0 }),
        ];
        let copying = heard(&lines);
        assert_eq!(copying.total, None, "a size of nothing is no size to say");
        assert_eq!(copying.percent(), 5);
    }

    #[test]
    fn what_the_card_reads_leaves_out_what_only_the_percent_needs() {
        let lines = [
            json!({ "slug": "work", "step": "begin", "index": 1, "count": 3, "bytes": 10 }),
            json!({ "slug": "work", "step": "volume", "done": 5, "total": 10 }),
        ];
        assert_eq!(
            serde_json::to_value(heard(&lines)).unwrap(),
            json!({ "slug": "work", "index": 1, "count": 3, "step": "volume", "done": 5, "total": 10 })
        );
        assert_eq!(
            serde_json::to_value(SetupMove::default()).unwrap(),
            json!({})
        );
    }

    #[test]
    fn the_moves_end_and_steps_it_does_not_know_change_nothing() {
        let begun = heard(&[
            json!({ "slug": "work", "step": "begin", "index": 0, "count": 1, "bytes": 10 }),
        ]);
        let mut after = begun.clone();
        after.hear(&json!({ "slug": "", "step": "done", "engine": "intentic", "count": 1 }));
        after.hear(&json!({ "slug": "work", "step": "someday" }));
        after.hear(&json!({ "slug": "work" }));
        assert_eq!(after, begun);
    }
}
