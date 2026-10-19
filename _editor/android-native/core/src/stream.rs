//! The turn `_tools/perf/src/chat/stream.ts` streams under a long chat, as a state machine driven by the caller's
//! clock: a prompt, then answers that grow by `chunk` characters every `every_ms`, each followed by its tool calls
//! (`tool_ms` running, `gap_ms` after), until `duration` has passed. The view calls `tick` once a frame and redraws
//! the rows it names; a late frame catches up on every step it missed, as a timer would have run them.

use crate::transcript::{Role, Row, StreamSpec, Tool, ToolStatus};

pub const PROMPT: &str = "Run the migration against a copy of the schema, then its tests.";
const TOOL_TARGET: &str = "api/src/users.ts";

#[derive(Clone, Copy, Debug)]
enum Phase {
    Prompt,
    Writing { row: usize, at: usize },
    ToolRunning { row: usize, tool: usize },
    ToolGap { row: usize, tool: usize },
}

pub struct Stream {
    spec: StreamSpec,
    prose: Vec<char>,
    deadline: u64,
    next: u64,
    phase: Phase,
    done: bool,
}

impl Stream {
    pub fn new(spec: StreamSpec, now_ms: u64, duration_ms: u64) -> Self {
        let prose = spec.prose.chars().collect();
        Stream {
            spec,
            prose,
            deadline: now_ms + duration_ms,
            next: now_ms,
            phase: Phase::Prompt,
            done: false,
        }
    }

    pub fn done(&self) -> bool {
        self.done
    }

    fn answer(&mut self, rows: &mut Vec<Row>, changed: &mut Vec<usize>) {
        rows.push(Row {
            role: Role::Assistant,
            text: String::new(),
            tools: Vec::new(),
        });
        changed.push(rows.len() - 1);
        self.phase = Phase::Writing {
            row: rows.len() - 1,
            at: 0,
        };
    }

    /// Runs every step due by `now_ms`, appending the rows it changed or added to `changed` (in order, possibly
    /// repeated). Returns whether the turn has ended.
    pub fn tick(&mut self, rows: &mut Vec<Row>, now_ms: u64, changed: &mut Vec<usize>) -> bool {
        while !self.done && self.next <= now_ms {
            match self.phase {
                Phase::Prompt => {
                    rows.push(Row {
                        role: Role::User,
                        text: PROMPT.into(),
                        tools: Vec::new(),
                    });
                    changed.push(rows.len() - 1);
                    self.answer(rows, changed);
                }
                Phase::Writing { row, at } => {
                    if self.next >= self.deadline {
                        self.done = true;
                    } else if at < self.prose.len() {
                        let end = (at + self.spec.chunk).min(self.prose.len());
                        rows[row].text.extend(&self.prose[at..end]);
                        changed.push(row);
                        self.phase = Phase::Writing { row, at: end };
                        self.next += self.spec.every_ms;
                    } else if self.spec.tools.is_empty() {
                        self.answer(rows, changed);
                    } else {
                        self.start_tool(rows, row, 0, changed);
                    }
                }
                Phase::ToolRunning { row, tool } => {
                    if let Some(call) = rows[row].tools.last_mut() {
                        call.status = ToolStatus::Done;
                    }
                    changed.push(row);
                    self.phase = Phase::ToolGap { row, tool };
                    self.next += self.spec.gap_ms;
                }
                Phase::ToolGap { row, tool } => {
                    if tool + 1 < self.spec.tools.len() {
                        self.start_tool(rows, row, tool + 1, changed);
                    } else if self.next >= self.deadline {
                        self.done = true;
                    } else {
                        self.answer(rows, changed);
                    }
                }
            }
        }
        self.done
    }

    fn start_tool(&mut self, rows: &mut [Row], row: usize, tool: usize, changed: &mut Vec<usize>) {
        rows[row].tools.push(Tool {
            name: self.spec.tools[tool].clone(),
            summary: TOOL_TARGET.into(),
            status: ToolStatus::Running,
        });
        changed.push(row);
        self.phase = Phase::ToolRunning { row, tool };
        self.next += self.spec.tool_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> StreamSpec {
        StreamSpec {
            prose: "abcdefghij".into(),
            chunk: 4,
            every_ms: 16,
            tools: vec!["Read".into(), "Bash".into()],
            tool_ms: 50,
            gap_ms: 30,
        }
    }

    #[test]
    fn writes_an_answer_then_runs_its_tools_on_the_clock() {
        let mut rows = Vec::new();
        let mut changed = Vec::new();
        let mut stream = Stream::new(spec(), 1_000, 10_000);
        stream.tick(&mut rows, 1_000, &mut changed);
        assert_eq!(rows[0].text, PROMPT);
        assert_eq!(
            rows[1].text, "abcd",
            "the first chunk lands with the empty answer"
        );
        stream.tick(&mut rows, 1_032, &mut changed);
        assert_eq!(rows[1].text, "abcdefghij");
        // Prose ran out at 1048: Read starts, finishes at 1098, Bash starts after the 30ms gap at 1128.
        stream.tick(&mut rows, 1_100, &mut changed);
        assert_eq!(rows[1].tools.len(), 1);
        assert_eq!(rows[1].tools[0].status, ToolStatus::Done);
        stream.tick(&mut rows, 1_128, &mut changed);
        assert_eq!(rows[1].tools[1].status, ToolStatus::Running);
        assert_eq!(rows[1].tools[1].summary, TOOL_TARGET);
        // Bash ends at 1178, its gap at 1208, and the next answer starts with its first chunk.
        stream.tick(&mut rows, 1_208, &mut changed);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2].text, "abcd");
    }

    #[test]
    fn stops_writing_at_the_deadline() {
        let mut rows = Vec::new();
        let mut changed = Vec::new();
        let mut stream = Stream::new(spec(), 0, 20);
        assert!(stream.tick(&mut rows, 1_000, &mut changed));
        assert_eq!(
            rows[1].text, "abcdefgh",
            "chunks at 0 and 16 only: the one due at 32 is past the deadline"
        );
    }
}
