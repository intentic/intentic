//! The conversation the spike draws: the web demo's `cnv_soft_deletes` (fixture/soft-deletes.json), inflated to any
//! number of rows exactly as `_tools/perf/src/mobile/page-scripts.ts` (`inflateTranscript`) inflates it, so every arm
//! of the spike and the web's own labs draw the same text.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User = 0,
    Assistant = 1,
    Notice = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Running = 0,
    Done = 1,
}

#[derive(Clone, Debug)]
pub struct Tool {
    pub name: String,
    pub summary: String,
    pub status: ToolStatus,
}

#[derive(Clone, Debug)]
pub struct Row {
    pub role: Role,
    pub text: String,
    pub tools: Vec<Tool>,
}

/// The streamed turn, as the fixture states it (`stream` in soft-deletes.json, from `_tools/perf/src/chat/stream.ts`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSpec {
    pub prose: String,
    pub chunk: usize,
    pub every_ms: u64,
    pub tools: Vec<String>,
    pub tool_ms: u64,
    pub gap_ms: u64,
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

#[derive(Debug)]
pub struct FixtureError(pub String);

impl std::fmt::Display for FixtureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn role_of(name: &str) -> Role {
    match name {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        _ => Role::Notice,
    }
}

/// The fixture's rows copied until there are `count` of them; every assistant answer of an even copy gains the
/// fixture's `addition` (a list, a table and a TypeScript block) with `{index}` replaced by the copy.
pub fn inflate(json: &str, count: usize) -> Result<(Vec<Row>, StreamSpec), FixtureError> {
    let fixture: Fixture =
        serde_json::from_str(json).map_err(|error| FixtureError(error.to_string()))?;
    if fixture.rows.is_empty() {
        return Err(FixtureError("the fixture has no rows".into()));
    }
    let mut rows = Vec::with_capacity(count);
    let mut copy = 0usize;
    while rows.len() < count {
        for source in &fixture.rows {
            if rows.len() == count {
                break;
            }
            let role = role_of(&source.role);
            let mut text = source.text.clone();
            if role == Role::Assistant && copy.is_multiple_of(2) {
                text.push_str(&fixture.addition.replace("{index}", &copy.to_string()));
            }
            let tools = source
                .tools
                .iter()
                .map(|tool| Tool {
                    name: tool.name.clone(),
                    summary: tool.summary.clone(),
                    status: ToolStatus::Done,
                })
                .collect();
            rows.push(Row { role, text, tools });
        }
        copy += 1;
    }
    Ok((rows, fixture.stream))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixture/soft-deletes.json");

    #[test]
    fn inflates_to_the_exact_count_with_additions_on_even_copies() {
        let (rows, stream) = inflate(FIXTURE, 2000).unwrap();
        assert_eq!(rows.len(), 2000);
        assert_eq!(stream.chunk, 24);
        // Row 1 is the first answer: copy 0 gains the addition, copy 1 (row 10) does not, copy 2 (row 19) does.
        assert!(rows[1].text.contains("What changed in step 0:"));
        assert!(!rows[10].text.contains("What changed"));
        assert!(rows[19].text.contains("What changed in step 2:"));
        assert_eq!(rows[0].role, Role::User);
    }

    #[test]
    fn refuses_a_fixture_with_no_rows() {
        let empty = r#"{"addition":"","stream":{"prose":"","chunk":1,"everyMs":1,"tools":[],"toolMs":1,"gapMs":1},"rows":[]}"#;
        assert!(inflate(empty, 10).is_err());
    }
}
