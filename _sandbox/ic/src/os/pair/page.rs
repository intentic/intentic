use serde_json::{json, Value};

/* WHAT THE PAIRING PAGE SHOWS: one form and where pairing stands, drawn by the server on every request, so it works on
any browser on the network with nothing loaded from anywhere and no script at all. While a code is being tried the page
reloads itself every few seconds; `/status` answers the same state as JSON for anything that would rather poll. */

/// Where pairing stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Waiting for a code.
    Waiting,
    /// A code is being tried: `ic sandbox connect` runs.
    Pairing,
    /// Paired; the process exits shortly.
    Done,
    /// The last code did not pair; another may be tried.
    Failed,
}

impl Phase {
    pub fn word(self) -> &'static str {
        match self {
            Phase::Waiting => "waiting",
            Phase::Pairing => "pairing",
            Phase::Done => "done",
            Phase::Failed => "failed",
        }
    }
}

/// The most lines of the connect's own output kept for the page.
pub const LOG_LINES: usize = 12;

/// Pairing's state, shared by the console, the page and the connect that runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub phase: Phase,
    /// One sentence for a person.
    pub message: String,
    /// The last lines the connect printed.
    pub log: Vec<String>,
}

impl State {
    pub fn waiting() -> State {
        State {
            phase: Phase::Waiting,
            message: "Waiting for a setup code.".to_string(),
            log: Vec::new(),
        }
    }

    /// Keep one more line of the connect's output, dropping the oldest past [`LOG_LINES`].
    pub fn push_log(&mut self, line: &str) {
        self.log.push(line.to_string());
        if self.log.len() > LOG_LINES {
            let over = self.log.len() - LOG_LINES;
            self.log.drain(..over);
        }
    }
}

/// `GET /status`. Pure.
pub fn status_json(state: &State) -> Value {
    json!({ "phase": state.phase.word(), "message": state.message, "log": state.log })
}

/// Text made safe to put in HTML. Pure.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const STYLE: &str = "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1rem;color:#1a1a1a;background:#fafafa}\
main{max-width:34rem;margin:0 auto}h1{font-size:1.5rem;margin:0 0 1rem}\
label{display:block;font-weight:600;margin:1.5rem 0 .25rem}\
input{box-sizing:border-box;width:100%;font:inherit;padding:.6rem;border:1px solid #767676;border-radius:4px}\
button{margin-top:.75rem;font:inherit;font-weight:600;padding:.6rem 1.2rem;border:0;border-radius:4px;background:#1a1a1a;color:#fff;cursor:pointer}\
button:disabled{background:#767676;cursor:default}\
:focus-visible{outline:3px solid #0b57d0;outline-offset:2px}\
.state{margin-top:1.5rem;padding:1rem;border-radius:4px;background:#fff;border:1px solid #d0d0d0}\
.notice{margin-top:1rem;padding:.75rem 1rem;border-radius:4px;background:#fdecea;border:1px solid #b3261e}\
pre{white-space:pre-wrap;word-break:break-word;font-size:.85rem;margin:.5rem 0 0}\
@media (prefers-color-scheme:dark){body{color:#eee;background:#121212}.state{background:#1e1e1e;border-color:#444}\
input{background:#1e1e1e;color:#eee;border-color:#999}button{background:#eee;color:#121212}\
.notice{background:#3b1512;border-color:#f2b8b5}}";

/// The whole page for `state`, with `notice` (a refused code) above the form. Pure.
pub fn page(state: &State, notice: Option<&str>) -> String {
    let busy = matches!(state.phase, Phase::Pairing | Phase::Done);
    let refresh = if state.phase == Phase::Pairing {
        "<meta http-equiv=\"refresh\" content=\"3\">"
    } else {
        ""
    };
    let notice = notice
        .map(|notice| format!("<p class=\"notice\" role=\"alert\">{}</p>", escape(notice)))
        .unwrap_or_default();
    let disabled = if busy { " disabled" } else { "" };
    let log = if state.log.is_empty() {
        String::new()
    } else {
        format!("<pre>{}</pre>", escape(&state.log.join("\n")))
    };
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">{refresh}\
<title>Pair this Intentic OS machine</title><style>{STYLE}</style></head><body><main>\
<h1>Pair this Intentic OS machine</h1>\
<p>Get a setup code on <strong>app.intentic.dev</strong>: choose <strong>New sandbox</strong>, then \
<strong>On my own machine</strong>. Paste the code here, or the whole setup command; the code is read out of it.</p>\
{notice}<form method=\"post\" action=\"/pair\"><label for=\"code\">Setup code or setup command</label>\
<input id=\"code\" name=\"code\" type=\"text\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" \
required{disabled}><button type=\"submit\"{disabled}>Pair this machine</button></form>\
<section class=\"state\" aria-live=\"polite\"><h2 style=\"font-size:1rem;margin:0\">{phase}</h2><p style=\"margin:.25rem 0 0\">{message}</p>{log}</section>\
</main></body></html>\n",
        phase = escape(heading(state.phase)),
        message = escape(&state.message),
    )
}

fn heading(phase: Phase) -> &'static str {
    match phase {
        Phase::Waiting => "Waiting for a code",
        Phase::Pairing => "Pairing…",
        Phase::Done => "Paired",
        Phase::Failed => "That code did not pair",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_is_one_self_contained_form_that_escapes_what_it_shows() {
        let mut state = State::waiting();
        state.phase = Phase::Failed;
        state.message = "the platform said <no>".to_string();
        state.push_log("error: \"code\" & co");
        let html = page(&state, Some("That is not a <setup> code."));
        assert!(html.contains("<form method=\"post\" action=\"/pair\">"));
        assert!(html.contains("<label for=\"code\">"));
        assert!(html.contains("name=\"code\""));
        assert!(html.contains("the platform said &lt;no&gt;"));
        assert!(html.contains("error: &quot;code&quot; &amp; co"));
        assert!(html.contains("That is not a &lt;setup&gt; code."));
        assert!(!html.contains("http-equiv=\"refresh\""));
        assert!(!html.contains(" disabled"));
        // Nothing loaded from anywhere, nothing run.
        assert!(!html.contains("<script"));
        assert!(!html.contains("src="));
        assert!(!html.contains("<link"));
    }

    #[test]
    fn while_a_code_is_tried_the_form_rests_and_the_page_reloads() {
        let mut state = State::waiting();
        state.phase = Phase::Pairing;
        let html = page(&state, None);
        assert!(html.contains("http-equiv=\"refresh\""));
        assert!(html.contains("required disabled"));
        state.phase = Phase::Done;
        let html = page(&state, None);
        assert!(!html.contains("http-equiv=\"refresh\""));
        assert!(html.contains("Paired"));
    }

    #[test]
    fn status_answers_the_same_state_and_keeps_only_the_last_lines() {
        let mut state = State::waiting();
        for line in 0..20 {
            state.push_log(&format!("line {line}"));
        }
        assert_eq!(state.log.len(), LOG_LINES);
        assert_eq!(state.log[0], "line 8");
        let status = status_json(&state);
        assert_eq!(status["phase"], "waiting");
        assert_eq!(status["message"], "Waiting for a setup code.");
        assert_eq!(status["log"].as_array().unwrap().len(), LOG_LINES);
    }
}
