//! A transcript row as the conversation list draws it: which view it goes in (`KIND_*`, mirrored by the app's
//! `Spans.kt`) and one string with its spans. Interactive parts (a card's buttons, a page's WebView) are the app's;
//! here a card is its title and the words it asks with, so the list can draw and measure it like any row.

use crate::bridge::{CardOption, CardQuestion, CardRow, CardRowKind};
use crate::render::{
    Builder, Rendered, SPAN_MUTED, SPAN_THINKING, SPAN_TITLE, SPAN_TODO, SPAN_TOOL,
};
use crate::wire::cards::{Card, CardKind};
use crate::wire::transcript::{Role, TodoStatus, Tool, ToolStatus, TranscriptRow};

pub const KIND_USER: i32 = 0;
pub const KIND_ASSISTANT: i32 = 1;
pub const KIND_NOTICE: i32 = 2;
/// A row holding a card; the app adds the card's answer buttons while it is pending.
pub const KIND_CARD: i32 = 3;
/// A page the agent showed: the app draws it in a WebView.
pub const KIND_PAGE: i32 = 4;

/// How deep a delegation's nested calls are drawn before they are counted instead.
const TOOL_DEPTH: usize = 2;
const THINKING_CHARS: usize = 120;
const TARGET_CHARS: usize = 72;

pub fn render(row: &TranscriptRow) -> (i32, Rendered) {
    let mut builder = Builder::with_capacity(row.text.len() + 64);
    let kind = if let Some((kind, card)) = row.card() {
        self::card(&mut builder, kind, card);
        KIND_CARD
    } else if row.page.is_some() {
        let title = row
            .page
            .as_ref()
            .and_then(|page| page.get("title"))
            .and_then(|title| title.as_str())
            .unwrap_or("Page");
        titled(&mut builder, title);
        KIND_PAGE
    } else {
        match row.role {
            Role::User => {
                builder.push(row.text.trim_end());
                for path in row.attachments.iter().flatten() {
                    builder.block(true);
                    let name = path.rsplit('/').next().unwrap_or(path);
                    muted(&mut builder, &format!("📎 {name}"));
                }
                KIND_USER
            }
            Role::Notice => {
                muted(&mut builder, row.text.trim());
                KIND_NOTICE
            }
            _ => {
                assistant(&mut builder, row);
                KIND_ASSISTANT
            }
        }
    };
    (kind, builder.finish())
}

fn assistant(builder: &mut Builder, row: &TranscriptRow) {
    if let Some(thinking) = row
        .thinking
        .as_deref()
        .map(str::trim)
        .filter(|thinking| !thinking.is_empty())
    {
        // One line of it: the latest paragraph's start, which is what the agent is thinking about now.
        let latest = thinking
            .rsplit("\n\n")
            .next()
            .unwrap_or(thinking)
            .replace('\n', " ");
        let start = builder.utf16();
        builder.push(&cut(&latest, THINKING_CHARS));
        builder.span(start, builder.utf16(), SPAN_THINKING, 0);
    }
    if !row.text.trim().is_empty() {
        builder.block(false);
        builder.markdown(&row.text);
    }
    for tool in row.tools.iter().flatten() {
        self::tool(builder, tool, 0);
    }
    for todo in row.todos.iter().flatten() {
        builder.block(true);
        let (mark, state, words) = match todo.status {
            TodoStatus::Completed => ("☑ ", 2, &todo.content),
            TodoStatus::InProgress => ("◐ ", 1, todo.active_form.as_ref().unwrap_or(&todo.content)),
            _ => ("☐ ", 0, &todo.content),
        };
        let start = builder.utf16();
        builder.push(mark);
        builder.push(words);
        builder.span(start, builder.utf16(), SPAN_TODO, state);
    }
}

fn tool(builder: &mut Builder, tool: &Tool, depth: usize) {
    builder.block(true);
    let start = builder.utf16();
    builder.push(&"    ".repeat(depth));
    let (mark, state) = match tool.status {
        ToolStatus::Completed => ("▸ ", 1),
        ToolStatus::Failed => ("✕ ", 2),
        _ => ("◌ ", 0),
    };
    builder.push(mark);
    builder.push(&tool.name);
    if let Some(target) = tool.target.as_deref().filter(|target| !target.is_empty()) {
        builder.push("  ");
        builder.push(&cut(target, TARGET_CHARS));
    }
    builder.span(start, builder.utf16(), SPAN_TOOL, state);
    let children = tool.children.as_deref().unwrap_or_default();
    if depth + 1 < TOOL_DEPTH {
        for child in children {
            self::tool(builder, child, depth + 1);
        }
    } else {
        let hidden = children.len() as u64 + tool.nested.unwrap_or(0);
        if hidden > 0 {
            builder.block(true);
            muted(
                builder,
                &format!("{}+{hidden} calls", "    ".repeat(depth + 1)),
            );
        }
    }
}

fn card(builder: &mut Builder, kind: CardKind, card: &Card) {
    let title = match kind {
        CardKind::Plan => "Plan",
        CardKind::Question => "Question",
        CardKind::Permission => "Permission",
        CardKind::BrowserHelp => "Help in the browser",
        CardKind::TerminalHelp => "Help in the terminal",
        CardKind::CapabilityOffer => "Connect",
        CardKind::PaymentOffer => "Payment",
        CardKind::CredentialOffer => "Credential",
        CardKind::PageAsk => "Page",
    };
    titled(builder, title);
    let words: Vec<String> = match kind {
        CardKind::Question => card
            .payload
            .get("questions")
            .and_then(|questions| questions.as_array())
            .map(|questions| {
                questions
                    .iter()
                    .filter_map(|question| question.get("question").and_then(|text| text.as_str()))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        CardKind::Permission => ["title", "toolName"]
            .iter()
            .find_map(|field| card.text(field))
            .map(|text| vec![text.to_owned()])
            .unwrap_or_default(),
        _ => ["text", "message", "title", "reason"]
            .iter()
            .find_map(|field| card.text(field))
            .map(|text| vec![text.to_owned()])
            .unwrap_or_default(),
    };
    for text in words {
        builder.block(false);
        if card.status.is_pending() {
            builder.markdown(&text);
        } else {
            muted(builder, &text);
        }
    }
    if !card.status.is_pending() {
        builder.block(true);
        muted(builder, card.status.as_str());
    }
}

/// What a card row's buttons need: its kind, its request id, and a question's questions or a permission's
/// always-label.
pub fn card_row(row: &TranscriptRow) -> Option<CardRow> {
    let (kind, card) = row.card()?;
    let text = |value: &serde_json::Value, field: &str| {
        value
            .get(field)
            .and_then(|text| text.as_str())
            .map(str::to_owned)
    };
    let questions = card
        .payload
        .get("questions")
        .and_then(|questions| questions.as_array())
        .map(|questions| {
            questions
                .iter()
                .map(|question| CardQuestion {
                    question: text(question, "question").unwrap_or_default(),
                    header: text(question, "header"),
                    multi_select: question
                        .get("multiSelect")
                        .and_then(|multi| multi.as_bool())
                        .unwrap_or(false),
                    options: question
                        .get("options")
                        .and_then(|options| options.as_array())
                        .map(|options| {
                            options
                                .iter()
                                .map(|option| CardOption {
                                    label: text(option, "label").unwrap_or_default(),
                                    description: text(option, "description"),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(CardRow {
        kind: match kind {
            CardKind::Plan => CardRowKind::Plan,
            CardKind::Question => CardRowKind::Question,
            CardKind::Permission => CardRowKind::Permission,
            CardKind::BrowserHelp => CardRowKind::BrowserHelp,
            CardKind::TerminalHelp => CardRowKind::TerminalHelp,
            CardKind::CapabilityOffer => CardRowKind::CapabilityOffer,
            CardKind::PaymentOffer => CardRowKind::PaymentOffer,
            CardKind::CredentialOffer => CardRowKind::CredentialOffer,
            CardKind::PageAsk => CardRowKind::PageAsk,
        },
        request_id: card.request_id.clone(),
        pending: card.status.is_pending(),
        questions,
        always_label: card.text("alwaysLabel").map(str::to_owned),
        page_id: card
            .payload
            .get("page")
            .and_then(|page| page.get("id"))
            .and_then(|id| id.as_str())
            .map(str::to_owned),
    })
}

/// A page row's page id: the web shows it full-screen at `/agents/<id>/pages/<page_id>`, always its latest drawing.
pub fn page_id(row: &TranscriptRow) -> Option<String> {
    row.page.as_ref()?.get("id")?.as_str().map(str::to_owned)
}

fn titled(builder: &mut Builder, title: &str) {
    let start = builder.utf16();
    builder.push(title);
    builder.span(start, builder.utf16(), SPAN_TITLE, 0);
}

fn muted(builder: &mut Builder, text: &str) {
    let start = builder.utf16();
    builder.push(text);
    builder.span(start, builder.utf16(), SPAN_MUTED, 0);
}

fn cut(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(chars - 1).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(json: serde_json::Value) -> TranscriptRow {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn draws_an_answer_with_its_thinking_tools_and_checklist() {
        let (kind, rendered) = render(&row(serde_json::json!({
            "role": "assistant",
            "text": "Done.",
            "thinking": "First idea.\n\nNow checking the schema",
            "tools": [{"id": "t", "name": "Read", "category": "read", "status": "completed", "target": "a.ts"}],
            "todos": [{"content": "Write it", "status": "completed"}, {"content": "Test it", "status": "in_progress", "activeForm": "Testing it"}],
        })));
        assert_eq!(kind, KIND_ASSISTANT);
        assert_eq!(
            rendered.text,
            "Now checking the schema\n\nDone.\n▸ Read  a.ts\n☑ Write it\n◐ Testing it"
        );
    }

    #[test]
    fn gives_a_question_cards_buttons_their_options() {
        let card = card_row(&row(serde_json::json!({
            "role": "assistant",
            "text": "",
            "question": {"requestId": "q1", "status": "pending", "questions": [
                {"question": "Which?", "header": "Pick", "multiSelect": false, "options": [{"label": "A"}, {"label": "B", "description": "the other"}]},
            ]},
        })))
        .unwrap();
        assert_eq!(card.kind, CardRowKind::Question);
        assert!(card.pending);
        assert_eq!(
            card.questions[0].options[1].description.as_deref(),
            Some("the other")
        );
    }

    #[test]
    fn draws_a_pending_question_card_by_its_questions() {
        let (kind, rendered) = render(&row(serde_json::json!({
            "role": "assistant",
            "text": "",
            "question": {"requestId": "q1", "status": "pending", "questions": [{"question": "Which **one**?"}]},
        })));
        assert_eq!(kind, KIND_CARD);
        assert_eq!(rendered.text, "Question\n\nWhich one?");
    }
}
