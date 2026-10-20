//! One open conversation: its rows as the record pages them back and as the newest run streams them in, each row
//! rendered once per change for the list that draws it. A run's patches count rows from its head's first, which sits
//! at `run_start` here; a page of older rows goes in front and moves every index, so it is said as an insertion at 0.

pub mod fixture;
pub mod row;

use crate::render::Rendered;
use crate::wire::attach::{AgentTranscript, TranscriptPatch};
use crate::wire::transcript::{Tool, TranscriptRow};
use std::sync::Arc;

/// A row as drawn, and the row's version: renewed by every change to it, so a row rendered outside the lock is kept
/// only if it is still the version it was read at.
#[derive(Default)]
struct Slot {
    stamp: u64,
    drawn: Option<Arc<(i32, Rendered)>>,
}

/// Row `index` drawn, rendered outside `rows`'s lock so the list's layout threads render rows side by side and a
/// streamed patch is never held up behind a render. Rendered once per change; `None` for a row that is not there.
pub fn read(rows: &std::sync::Mutex<Conversation>, index: usize) -> Option<Arc<(i32, Rendered)>> {
    let (stamp, row) = {
        let held = rows.lock().ok()?;
        let slot = held.rendered.get(index)?;
        if let Some(drawn) = &slot.drawn {
            return Some(drawn.clone());
        }
        (slot.stamp, held.rows.get(index)?.clone())
    };
    let drawn = Arc::new(row::render(&row));
    if let Ok(mut held) = rows.lock() {
        held.keep(index, stamp, drawn.clone());
    }
    Some(drawn)
}

/// How many rows stay drawn: a few screens around wherever the list was read last. A 2,000-row conversation flung
/// end to end would otherwise keep every row's text twice, here and in the app's layouts.
const KEPT: usize = 160;

/// What one step did to the rows, in the terms a list adapter is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Reset,
    Inserted { at: usize, count: usize },
    Changed { at: usize, count: usize },
    Removed { at: usize, count: usize },
}

#[derive(Default)]
pub struct Conversation {
    rows: Vec<TranscriptRow>,
    rendered: Vec<Slot>,
    next_stamp: u64,
    /// The stamps of the rows kept drawn, oldest first: the first to go past [`KEPT`].
    kept: std::collections::VecDeque<u64>,
    /// Where `rows[0]` sits in the whole record: the `before` that asks for the page above.
    from: u64,
    more: bool,
    /// The run streaming in, and the index of its head's first row.
    run: Option<(String, usize)>,
    live: bool,
    /// Message ids of rows this phone sent and shows ahead of the daemon's copy, which replaces each as it arrives.
    pending: Vec<String>,
}

impl Conversation {
    fn slot(&mut self) -> Slot {
        self.next_stamp += 1;
        Slot {
            stamp: self.next_stamp,
            drawn: None,
        }
    }

    /// Keeps row `index` drawn if it is still the version `stamp`, letting the longest-kept row go past [`KEPT`].
    fn keep(&mut self, index: usize, stamp: u64, drawn: Arc<(i32, Rendered)>) {
        let Some(slot) = self.rendered.get_mut(index) else {
            return;
        };
        if slot.stamp != stamp {
            return;
        }
        slot.drawn = Some(drawn);
        self.kept.push_back(stamp);
        while self.kept.len() > KEPT {
            let Some(oldest) = self.kept.pop_front() else {
                break;
            };
            // Gone already when its row changed or went: then its stamp matches nothing.
            if let Some(slot) = self.rendered.iter_mut().find(|slot| slot.stamp == oldest) {
                slot.drawn = None;
            }
        }
    }

    fn slots(&mut self, count: usize) -> Vec<Slot> {
        (0..count).map(|_| self.slot()).collect()
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Older rows precede the first one held.
    pub fn more(&self) -> bool {
        self.more
    }

    pub fn from(&self) -> u64 {
        self.from
    }

    /// A run is streaming in.
    pub fn live(&self) -> bool {
        self.live
    }

    pub fn run(&self) -> Option<&str> {
        self.run.as_ref().map(|(run, _)| run.as_str())
    }

    /// The newest page, in place of everything held.
    pub fn reset(&mut self, page: AgentTranscript) -> Change {
        self.rendered = self.slots(page.messages.len());
        self.rows = page.messages;
        self.from = page.from;
        self.more = page.more;
        self.run = None;
        self.live = false;
        self.pending.clear();
        Change::Reset
    }

    /// Rows that come from no record (the fixture): held as a finished page with nothing above it.
    pub fn local(&mut self, rows: Vec<TranscriptRow>) -> Change {
        self.reset(AgentTranscript {
            messages: rows,
            from: 0,
            more: false,
            session_id: None,
            provider: None,
            account: None,
            ending: None,
        })
    }

    /// A message this phone just sent, shown at once; the daemon's own row for it takes its place when it comes.
    pub fn sent(&mut self, row: TranscriptRow) -> Change {
        if let Some(id) = &row.message_id {
            self.pending.push(id.clone());
        }
        self.rows.push(row);
        let slot = self.slot();
        self.rendered.push(slot);
        Change::Inserted {
            at: self.rows.len() - 1,
            count: 1,
        }
    }

    /// Takes away the sent rows whose daemon copies are among `incoming`.
    fn settle(&mut self, incoming: &[TranscriptRow]) -> Vec<Change> {
        let arrived: Vec<&str> = incoming
            .iter()
            .filter_map(|row| row.message_id.as_deref())
            .filter(|id| self.pending.iter().any(|pending| pending == id))
            .collect();
        if arrived.is_empty() {
            return Vec::new();
        }
        let mut changes = Vec::new();
        for index in (0..self.rows.len()).rev() {
            let row = &self.rows[index];
            if row.run.is_none()
                && row
                    .message_id
                    .as_deref()
                    .is_some_and(|id| arrived.contains(&id))
            {
                self.rows.remove(index);
                self.rendered.remove(index);
                changes.push(Change::Removed {
                    at: index,
                    count: 1,
                });
            }
        }
        let arrived: Vec<String> = arrived.into_iter().map(str::to_owned).collect();
        self.pending.retain(|id| !arrived.contains(id));
        changes
    }

    /// The page above the first row held, in front of it.
    pub fn older(&mut self, page: AgentTranscript) -> Change {
        let count = page.messages.len();
        self.rows.splice(0..0, page.messages);
        let slots = self.slots(count);
        self.rendered.splice(0..0, slots);
        self.from = page.from;
        self.more = page.more;
        if let Some((_, start)) = &mut self.run {
            *start += count;
        }
        Change::Inserted { at: 0, count }
    }

    /// A run's head: its rows so far take the place of whatever of that run the page already held (the run's rows
    /// are the newest, so they are the tail), or follow it.
    pub fn attached(&mut self, run: String, rows: Vec<TranscriptRow>) -> Vec<Change> {
        let mut changes = self.settle(&rows);
        let start = self
            .rows
            .iter()
            .position(|row| row.run.as_deref() == Some(run.as_str()))
            .unwrap_or(self.rows.len());
        let before = self.rows.len() - start;
        let after = rows.len();
        self.rows.truncate(start);
        self.rows.extend(rows);
        self.rendered.truncate(start);
        let slots = self.slots(self.rows.len() - start);
        self.rendered.extend(slots);
        self.run = Some((run, start));
        self.live = true;
        if before.min(after) > 0 {
            changes.push(Change::Changed {
                at: start,
                count: before.min(after),
            });
        }
        if after > before {
            changes.push(Change::Inserted {
                at: start + before,
                count: after - before,
            });
        } else if before > after {
            changes.push(Change::Removed {
                at: start + after,
                count: before - after,
            });
        }
        changes
    }

    /// The run ended: every frame has been delivered.
    pub fn ended(&mut self) {
        self.live = false;
    }

    /// Applies one patch of the live run: what it changed, in order. Nothing when it changed nothing a list shows
    /// (no run, an index past the rows, a kind this build does not know).
    pub fn apply(&mut self, patch: TranscriptPatch) -> Vec<Change> {
        if let TranscriptPatch::Append { row } = &patch {
            let mut changes = self.settle(std::slice::from_ref(row));
            changes.extend(self.patch(patch));
            return changes;
        }
        self.patch(patch).into_iter().collect()
    }

    fn patch(&mut self, patch: TranscriptPatch) -> Option<Change> {
        let start = self.run.as_ref()?.1;
        let at = |index: u64| start + index as usize;
        match patch {
            TranscriptPatch::Append { row } => {
                self.rows.push(*row);
                let slot = self.slot();
                self.rendered.push(slot);
                Some(Change::Inserted {
                    at: self.rows.len() - 1,
                    count: 1,
                })
            }
            TranscriptPatch::Replace { index, row } => {
                let index = at(index);
                *self.rows.get_mut(index)? = *row;
                self.changed(index)
            }
            TranscriptPatch::Drop { index } => {
                let index = at(index);
                if index >= self.rows.len() {
                    return None;
                }
                self.rows.remove(index);
                self.rendered.remove(index);
                Some(Change::Removed {
                    at: index,
                    count: 1,
                })
            }
            TranscriptPatch::Text { index, text } => {
                let index = at(index);
                self.rows.get_mut(index)?.text.push_str(&text);
                self.changed(index)
            }
            TranscriptPatch::Thinking { index, text } => {
                let index = at(index);
                self.rows
                    .get_mut(index)?
                    .thinking
                    .get_or_insert_default()
                    .push_str(&text);
                self.changed(index)
            }
            TranscriptPatch::ToolThinking { index, id, text } => {
                let index = at(index);
                let tools = self.rows.get_mut(index)?.tools.as_mut()?;
                find_tool(tools, &id)?
                    .thinking
                    .get_or_insert_default()
                    .push_str(&text);
                self.changed(index)
            }
            TranscriptPatch::Tool {
                index,
                tool,
                parent,
            } => {
                let index = at(index);
                let tools = self.rows.get_mut(index)?.tools.get_or_insert_default();
                upsert_tool(tools, *tool, parent.as_deref());
                self.changed(index)
            }
            TranscriptPatch::Other(_) => None,
        }
    }

    fn changed(&mut self, index: usize) -> Option<Change> {
        let slot = self.slot();
        *self.rendered.get_mut(index)? = slot;
        Some(Change::Changed {
            at: index,
            count: 1,
        })
    }

    /// Row `index`'s page id, for a row showing a page.
    pub fn page_id(&self, index: usize) -> Option<String> {
        row::page_id(self.rows.get(index)?)
    }

    /// What row `index`'s card buttons need, for a row holding a card.
    pub fn card(&self, index: usize) -> Option<crate::bridge::CardRow> {
        row::card_row(self.rows.get(index)?)
    }

    /// Row `index` drawn: its view kind (`row::KIND_*`) and its text and spans, rendered once per change.
    pub fn rendered(&mut self, index: usize) -> Option<Arc<(i32, Rendered)>> {
        if let Some(drawn) = self.rendered.get(index).and_then(|slot| slot.drawn.clone()) {
            return Some(drawn);
        }
        let drawn = Arc::new(row::render(self.rows.get(index)?));
        let stamp = self.rendered[index].stamp;
        self.keep(index, stamp, drawn.clone());
        Some(drawn)
    }
}

/// The call `id` among `tools` or anywhere under them.
fn find_tool<'a>(tools: &'a mut [Tool], id: &str) -> Option<&'a mut Tool> {
    for tool in tools.iter_mut() {
        if tool.id == id {
            return Some(tool);
        }
        if let Some(found) = tool
            .children
            .as_deref_mut()
            .and_then(|children| find_tool(children, id))
        {
            return Some(found);
        }
    }
    None
}

fn holds_tool(tools: &[Tool], id: &str) -> bool {
    tools.iter().any(|tool| {
        tool.id == id
            || tool
                .children
                .as_deref()
                .is_some_and(|children| holds_tool(children, id))
    })
}

/// A card's latest fields: in place where it already is (keeping its children and reasoning, which a patch never
/// carries), under `parent` when a delegation made it, or at the end.
fn upsert_tool(tools: &mut Vec<Tool>, mut tool: Tool, parent: Option<&str>) {
    if holds_tool(tools, &tool.id) {
        if let Some(existing) = find_tool(tools, &tool.id) {
            tool.children = existing.children.take();
            tool.thinking = tool.thinking.or_else(|| existing.thinking.take());
            *existing = tool;
        }
        return;
    }
    if let Some(parent) = parent.filter(|parent| holds_tool(tools, parent))
        && let Some(parent) = find_tool(tools, parent)
    {
        parent.children.get_or_insert_default().push(tool);
        return;
    }
    tools.push(tool);
}

#[cfg(test)]
mod tests;
