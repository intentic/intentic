//! The spike's fixture conversation (`../android-native/fixture/soft-deletes.json`) as real transcript rows and real
//! patches, so the app's own conversation screen can be measured and previewed without a sandbox: the same 2,000 rows
//! and the same streamed turn every arm of the spike drew (`../android-native/README.md`).

use crate::wire::attach::TranscriptPatch;
use crate::wire::transcript::{Tool, ToolKind, ToolStatus, TranscriptRow};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSpec {
    prose: String,
    chunk: usize,
    every_ms: u64,
    tools: Vec<String>,
    tool_ms: u64,
    gap_ms: u64,
}

#[derive(Deserialize)]
struct FixtureTool {
    name: String,
    summary: String,
}

#[derive(Deserialize)]
struct FixtureRow {
    role: String,
    text: String,
    tools: Vec<FixtureTool>,
}

#[derive(Deserialize)]
struct Fixture {
    addition: String,
    stream: StreamSpec,
    rows: Vec<FixtureRow>,
}

const PROMPT: &str = "Run the migration against a copy of the schema, then its tests.";
const TOOL_TARGET: &str = "api/src/users.ts";

fn tool(index: usize, name: &str, target: &str, status: ToolStatus) -> Tool {
    serde_json::from_value(serde_json::json!({
        "id": format!("fixture-{index}-{name}"),
        "name": name,
        "category": ToolKind::Read.as_str(),
        "status": status.as_str(),
        "target": (!target.is_empty()).then_some(target),
    }))
    .expect("a fixture tool is a tool")
}

fn row(role: &str, text: String, tools: Vec<Tool>) -> TranscriptRow {
    serde_json::from_value(serde_json::json!({
        "role": role,
        "text": text,
        "tools": (!tools.is_empty()).then_some(tools),
    }))
    .expect("a fixture row is a row")
}

/// The fixture's rows copied until there are `count`; every assistant answer of an even copy gains the fixture's
/// `addition` (a list, a table and a TypeScript block), the rule `_tools/perf` inflates the demo's conversation by.
pub fn inflate(
    json: &str,
    count: usize,
) -> Result<(Vec<TranscriptRow>, StreamSpec), serde_json::Error> {
    let fixture: Fixture = serde_json::from_str(json)?;
    let mut rows = Vec::with_capacity(count);
    let mut copy = 0usize;
    while rows.len() < count && !fixture.rows.is_empty() {
        for source in &fixture.rows {
            if rows.len() == count {
                break;
            }
            let mut text = source.text.clone();
            if source.role == "assistant" && copy.is_multiple_of(2) {
                text.push_str(&fixture.addition.replace("{index}", &copy.to_string()));
            }
            let tools = source
                .tools
                .iter()
                .map(|fixture| {
                    tool(
                        rows.len(),
                        &fixture.name,
                        &fixture.summary,
                        ToolStatus::Completed,
                    )
                })
                .collect();
            rows.push(row(&source.role, text, tools));
        }
        copy += 1;
    }
    Ok((rows, fixture.stream))
}

enum Phase {
    Prompt,
    Writing { row: u64, at: usize },
    ToolRunning { row: u64, tool: usize },
    ToolGap { row: u64, tool: usize },
}

/// The turn `_tools/perf/src/chat/stream.ts` streams, as the patches a daemon would send: a prompt, then answers that
/// grow by `chunk` characters every `every_ms`, each followed by its tool calls, until the duration has passed.
/// Indices count from the run's first row, as a real run's do.
pub struct Stream {
    spec: StreamSpec,
    prose: Vec<char>,
    rows: u64,
    deadline: u64,
    next: u64,
    phase: Phase,
    done: bool,
}

impl Stream {
    pub fn new(spec: StreamSpec, now_ms: u64, duration_ms: u64) -> Stream {
        Stream {
            prose: spec.prose.chars().collect(),
            spec,
            rows: 0,
            deadline: now_ms + duration_ms,
            next: now_ms,
            phase: Phase::Prompt,
            done: false,
        }
    }

    pub fn done(&self) -> bool {
        self.done
    }

    fn answer(&mut self, patches: &mut Vec<TranscriptPatch>) {
        patches.push(TranscriptPatch::Append {
            row: Box::new(row("assistant", String::new(), Vec::new())),
        });
        self.phase = Phase::Writing {
            row: self.rows,
            at: 0,
        };
        self.rows += 1;
    }

    fn tool(
        &mut self,
        row: u64,
        index: usize,
        status: ToolStatus,
        patches: &mut Vec<TranscriptPatch>,
    ) {
        let name = &self.spec.tools[index];
        patches.push(TranscriptPatch::Tool {
            index: row,
            tool: Box::new(tool(row as usize, name, TOOL_TARGET, status)),
            parent: None,
        });
    }

    /// The patches due by `now_ms`; a late tick catches up on every step it missed, as a timer would have run them.
    pub fn tick(&mut self, now_ms: u64) -> Vec<TranscriptPatch> {
        let mut patches = Vec::new();
        while !self.done && self.next <= now_ms {
            match self.phase {
                Phase::Prompt => {
                    patches.push(TranscriptPatch::Append {
                        row: Box::new(row("user", PROMPT.into(), Vec::new())),
                    });
                    self.rows += 1;
                    self.answer(&mut patches);
                }
                Phase::Writing { row, at } => {
                    if self.next >= self.deadline {
                        self.done = true;
                    } else if at < self.prose.len() {
                        let end = (at + self.spec.chunk).min(self.prose.len());
                        patches.push(TranscriptPatch::Text {
                            index: row,
                            text: self.prose[at..end].iter().collect(),
                        });
                        self.phase = Phase::Writing { row, at: end };
                        self.next += self.spec.every_ms;
                    } else if self.spec.tools.is_empty() {
                        self.answer(&mut patches);
                    } else {
                        self.tool(row, 0, ToolStatus::InProgress, &mut patches);
                        self.phase = Phase::ToolRunning { row, tool: 0 };
                        self.next += self.spec.tool_ms;
                    }
                }
                Phase::ToolRunning { row, tool } => {
                    self.tool(row, tool, ToolStatus::Completed, &mut patches);
                    self.phase = Phase::ToolGap { row, tool };
                    self.next += self.spec.gap_ms;
                }
                Phase::ToolGap { row, tool } => {
                    if tool + 1 < self.spec.tools.len() {
                        self.tool(row, tool + 1, ToolStatus::InProgress, &mut patches);
                        self.phase = Phase::ToolRunning {
                            row,
                            tool: tool + 1,
                        };
                        self.next += self.spec.tool_ms;
                    } else if self.next >= self.deadline {
                        self.done = true;
                    } else {
                        self.answer(&mut patches);
                    }
                }
            }
        }
        patches
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::Conversation;

    const FIXTURE: &str = include_str!("../../../android-native/fixture/soft-deletes.json");

    #[test]
    fn inflates_the_spikes_conversation_and_streams_its_turn_as_patches() {
        let (rows, spec) = inflate(FIXTURE, 2000).unwrap();
        assert_eq!(rows.len(), 2000);
        assert!(rows[1].text.contains("What changed in step 0:"));
        assert!(!rows[10].text.contains("What changed"));
        let mut conversation = Conversation::default();
        conversation.attached("fixture".into(), Vec::new());
        let mut stream = Stream::new(spec, 0, 1_000);
        let mut now = 0;
        while !stream.done() {
            for patch in stream.tick(now) {
                conversation.apply(patch);
            }
            now += 16;
        }
        // A prompt and at least one answer that grew and ran its tools.
        assert!(conversation.len() >= 2);
        assert_eq!(conversation.rendered(0).unwrap().1.text, PROMPT);
        assert!(
            conversation.rendered(1).unwrap().1.text.contains("◌ Read")
                || conversation.rendered(1).unwrap().1.text.contains("▸ ")
        );
    }
}
