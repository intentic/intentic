/* `ic uninstall`: INTENTIC OFF THIS DEVICE, in one command, from whichever door a person comes in by.

The Windows uninstaller's page, the desktop app's "Uninstall Intentic…" and the `intentic.dev/uninstall` one-liner all
end up here, so there is one list of what Intentic put on a device and one order to take it off in. Before 2026-10-18
that knowledge was in four places that each removed their own part: `ic sandbox remove`, `ic engine remove`,
`intentic-machine uninstall` and the NSIS hook. None of them removed ic itself, and between them they left Mutagen and
its data, PATH entries, the keyring, the engine's download cache, images, logs and `~/.intentic` behind.

The run reads the device (inventory.rs), decides from that and the command line what to ask and what to do (plan.rs,
pure), asks once, then runs its steps (steps.rs) as one checklist. A step that cannot finish leaves its thing behind
with the command that finishes it, and the run carries on. The end names everything left and why, and what stays
because it is not Intentic's (Docker Desktop, WSL, the synced folders' files).

For a reader with no screen (the desktop app's dialog, the Windows uninstaller's details list), each step is also one
`intentic-uninstall: {json}` line (cli-output-protocol.md), and `--dry-run --json` / `--ini` answer the inventory the
choice is shown from. */

mod host;
mod inventory;
mod plan;
mod steps;

use std::path::PathBuf;

use serde_json::json;

use crate::ui;
use crate::util::{Fail, Result};
use plan::{Choice, Decision, Planned, Step};
use steps::End;

pub struct Args {
    pub keep_sandboxes: bool,
    pub delete_data: bool,
    pub confirm: Option<String>,
    pub yes: bool,
    pub dry_run: bool,
    pub json: bool,
    pub ini: Option<PathBuf>,
    pub without_app: bool,
    pub nested: bool,
}

const TITLE: &str = "intentic · uninstall from this device";

pub fn run(args: Args) -> Result<()> {
    if args.json {
        ui::send_human_to_stderr();
    }
    let inventory = inventory::gather();
    if args.dry_run {
        return dry_run(&inventory, &args);
    }
    let facts = &inventory.facts;
    let asked = plan::Asked {
        keep_sandboxes: args.keep_sandboxes,
        delete_data: args.delete_data,
        confirm: args.confirm.clone(),
        yes: args.yes,
        interactive: crate::tty::have_tty(),
        nested: args.nested,
    };
    let decision = plan::decide(facts, &asked);
    if let Decision::Stop(stop) = decision {
        return Err(Fail(stop));
    }
    let asks = !matches!(decision, Decision::Go(_));
    if asks || ui::is_rich() {
        show(&inventory);
    }
    let choice = match decision {
        Decision::Go(choice) => choice,
        Decision::Confirm(choice) => {
            let (question, consequence) = plan::confirm_question(facts, choice);
            if !ui::confirm(&question, &consequence, false)? {
                ui::cancelled();
                return Ok(());
            }
            choice
        }
        Decision::Typed => {
            if !typed(facts)? {
                ui::cancelled();
                return Ok(());
            }
            Choice::Everything
        }
        Decision::Pick => {
            let (question, rows) = plan::pick_question(facts);
            match ui::choose(&question, &rows, 0)? {
                Some(0) if facts.sandboxes > 0 => {
                    if !typed(facts)? {
                        ui::cancelled();
                        return Ok(());
                    }
                    Choice::Everything
                }
                Some(0) => Choice::Everything,
                Some(_) => Choice::KeepSandboxes,
                None => {
                    ui::cancelled();
                    return Ok(());
                }
            }
        }
        Decision::Stop(_) => unreachable!("stopped above"),
    };
    if choice == Choice::KeepSandboxes && facts.has_data() && !args.keep_sandboxes {
        ui::note(&format!(
            "Keeping {}: --delete-data deletes {}.",
            plan::data_phrase(facts),
            if facts.sandboxes + usize::from(facts.passwords) == 1 {
                "it"
            } else {
                "them"
            }
        ));
    }
    execute(&inventory, choice, &args)
}

/// The typed count that stands between choosing EVERYTHING and deleting sandboxes.
fn typed(facts: &plan::Facts) -> Result<bool> {
    let (question, consequence) = plan::typed_question(facts);
    ui::confirm_typed(&question, &consequence, &facts.sandboxes.to_string(), None)
}

/// What is here and what stays, before anything is asked or done: the report a person decides from.
fn show(inventory: &inventory::Inventory) {
    let facts = &inventory.facts;
    ui::report(TITLE, Some(&scope()));
    ui::section("found");
    ui::items(&found_items(inventory));
    let stays = plan::stays(facts);
    if !stays.is_empty() {
        ui::section("stays, not Intentic's");
        ui::items(&[ui::Item::new(ui::Tone::Skip, plan::and_list(&stays), "")]);
    }
}

fn scope() -> String {
    let device = crate::sandbox::connect::machine_label();
    format!("{device} · everything Intentic put on this device")
}

/// The report's rows: what each thing is, and how big. The person's own data is marked, since it is what a choice
/// decides about.
fn found_items(inventory: &inventory::Inventory) -> Vec<ui::Item> {
    let facts = &inventory.facts;
    let mut items = Vec::new();
    let skip = |name: &str, meta: String| ui::Item::new(ui::Tone::Skip, name, meta);
    if let Some(app) = &inventory.app {
        items.push(skip(
            "the Intentic app",
            app.version.clone().unwrap_or_default(),
        ));
    }
    if facts.sandboxes > 0 {
        let mut meta = Vec::new();
        if let Some(bytes) = facts.data_bytes.filter(|bytes| *bytes > 0) {
            meta.push(plan::size(bytes));
        }
        meta.push(inventory.sandbox_list_names());
        items.push(ui::Item::new(
            ui::Tone::Warn,
            crate::util::plural(facts.sandboxes, "sandbox"),
            meta.join(" · "),
        ));
    }
    if facts.passwords {
        items.push(ui::Item::new(
            ui::Tone::Warn,
            "your saved passwords",
            "the keyring's vault",
        ));
    }
    if facts.engine {
        let mut meta = facts
            .engine_bytes
            .filter(|bytes| *bytes > 0)
            .map(plan::size)
            .unwrap_or_default();
        if facts.engine_holds_others {
            meta = format!("{meta} · also runs containers that are not Intentic's, so it stays")
                .trim_start_matches(" · ")
                .to_string();
        }
        items.push(skip("the intentic engine", meta));
    }
    if facts.agent {
        items.push(skip(
            "the machine agent",
            if facts.folders > 0 {
                format!("syncing {}", crate::util::plural(facts.folders, "folder"))
            } else {
                String::new()
            },
        ));
    }
    if facts.windows && !facts.distros.is_empty() {
        items.push(skip("Intentic in WSL", facts.distros.join(", ")));
    }
    if facts.cache_bytes > 0 {
        items.push(skip("caches and logs", plan::size(facts.cache_bytes)));
    }
    items.push(skip("ic", String::new()));
    items
}

/// `--dry-run`: what is here and what each outcome would do, changing nothing. `--json` and `--ini` are the same answer
/// for a program: the desktop app's dialog and the Windows uninstaller's page.
fn dry_run(inventory: &inventory::Inventory, args: &Args) -> Result<()> {
    if let Some(path) = &args.ini {
        let text = plan::ini(&inventory.facts, &inventory.sandbox_list());
        std::fs::write(path, plan::utf16_with_bom(&text))
            .map_err(|error| Fail(format!("{} could not be written: {error}", path.display())))?;
    }
    if args.json {
        let document =
            serde_json::to_string(&inventory.document(args.without_app)).map_err(|error| {
                Fail(format!(
                    "the inventory could not be written as JSON: {error}"
                ))
            })?;
        // Straight to stdout: under --json the println! of this crate sends human lines to stderr (main.rs), and this
        // is the one line that is not one.
        use std::io::Write as _;
        // allow(terminal-output): the --json answer, one line the desktop app reads (uninstall.rs).
        let _ = writeln!(std::io::stdout(), "{document}");
        return Ok(());
    }
    if args.ini.is_some() {
        return Ok(());
    }
    show(inventory);
    for (title, choice) in [
        ("remove everything (ic uninstall)", Choice::Everything),
        (
            "keep my sandboxes (ic uninstall --keep-sandboxes)",
            Choice::KeepSandboxes,
        ),
    ] {
        ui::section(title);
        let rows: Vec<ui::Item> = plan::steps(&inventory.facts, choice, args.without_app)
            .into_iter()
            .map(|planned| ui::Item::new(ui::Tone::Skip, planned.label, ""))
            .collect();
        ui::items(&rows);
    }
    ui::quiet("Nothing was changed.");
    if inventory.facts.sandboxes > 0 {
        ui::later(&[(
            "delete everything, unattended".to_string(),
            format!(
                "ic uninstall --delete-data --confirm {}",
                inventory.facts.sandboxes
            ),
        )]);
    }
    Ok(())
}

/// One thing a run could not finish.
struct Left {
    label: String,
    problem: String,
    fix: String,
}

/// One `intentic-uninstall:` line, for a reader with no screen. Plain mode only: on a screen the checklist says it.
fn marker(value: serde_json::Value) {
    if !ui::is_rich() {
        // allow(terminal-output): a column-0 marker the desktop app and the Windows uninstaller read (uninstall.rs).
        println!("intentic-uninstall: {value}");
    }
}

fn execute(inventory: &inventory::Inventory, choice: Choice, args: &Args) -> Result<()> {
    let facts = &inventory.facts;
    let planned = plan::steps(facts, choice, args.without_app);
    marker(json!({
        "plan": planned.iter().map(|step| json!({"step": step.step.id(), "label": step.label})).collect::<Vec<_>>(),
        "choice": choice.id(),
    }));
    ui::continue_with(planned.iter().map(plan_step).collect());
    let mut left: Vec<Left> = Vec::new();
    let mut failed: Vec<Step> = Vec::new();
    for step in &planned {
        marker(json!({"step": step.step.id(), "state": "running", "label": step.label}));
        ui::step(step.step.id(), &step.label);
        let end = run_step(step.step, inventory, choice, args, &failed);
        if matches!(end, End::Left { .. }) {
            failed.push(step.step);
        }
        let (state, tone, detail) = match end {
            End::Done(note) => ("done", ui::Tone::Ok, note),
            End::Skipped(why) => ("skipped", ui::Tone::Skip, Some(why)),
            End::Left { problem, fix } => {
                left.push(Left {
                    label: step.label.clone(),
                    problem: problem.clone(),
                    fix,
                });
                ("failed", ui::Tone::Warn, Some(problem))
            }
        };
        if let Some(detail) = &detail {
            if state != "failed" {
                ui::note(detail);
            }
        }
        ui::settle_step(tone);
        let mut line = json!({"step": step.step.id(), "state": state, "label": step.label});
        if let Some(detail) = detail {
            line["detail"] = json!(detail);
        }
        marker(line);
    }
    let stays = plan::stays(facts);
    marker(json!({
        "result": if left.is_empty() { "done" } else { "partial" },
        "choice": choice.id(),
        "stays": stays,
        "failed": left.iter().map(|one| json!({"label": one.label, "problem": one.problem, "fix": one.fix})).collect::<Vec<_>>(),
    }));
    let verdict = plan::verdict(facts, choice, left.len());
    let instruction = if stays.is_empty() {
        String::new()
    } else {
        format!(
            "{} stay: they are not Intentic's.",
            plan::capitalize(&plan::and_list(&stays))
        )
    };
    if !left.is_empty() {
        return Err(Fail(stop_message(&verdict, &left)));
    }
    if ui::is_rich() {
        let footnotes = match choice {
            Choice::Everything => Vec::new(),
            Choice::KeepSandboxes => {
                vec![("remove the rest".to_string(), "ic uninstall".to_string())]
            }
        };
        ui::finished(&verdict, None, &instruction, &footnotes);
    } else {
        ui::done(&verdict);
    }
    Ok(())
}

/// The stop a run that left something ends on: the verdict, then each thing left, numbered, with its own fix.
fn stop_message(verdict: &str, left: &[Left]) -> String {
    let mut message = verdict.to_string();
    for (index, one) in left.iter().enumerate() {
        message.push_str(&format!(
            "\n\n  {}. {}\n   problem: {}\n   fix:     {}",
            index + 1,
            one.label,
            one.problem,
            one.fix
        ));
    }
    message
}

/// The checklist's own step: its wire name, its words and a guess at its seconds (only ever compared).
fn plan_step(planned: &Planned) -> ui::PlanStep {
    let weight = match planned.step {
        Step::Sandboxes | Step::Engine | Step::Distros => 20,
        Step::Agent | Step::App => 10,
        _ => 2,
    };
    ui::PlanStep {
        phase: planned.step.id(),
        // One label per step of one run: a few short strings for the life of the process.
        label: Box::leak(planned.label.clone().into_boxed_str()),
        weight,
    }
}

/// One step, knowing which before it left something: whatever finishes the job later must still be here, so a failed
/// agent step keeps the agent's folder, and any failure keeps ic itself, which every fix names (`ic uninstall` again).
fn run_step(
    step: Step,
    inventory: &inventory::Inventory,
    choice: Choice,
    args: &Args,
    failed: &[Step],
) -> End {
    match step {
        Step::Stop => steps::stop(inventory, choice, args.without_app),
        Step::Distros => steps::distros(inventory),
        Step::Sandboxes => steps::sandboxes(inventory),
        Step::Agent => steps::agent(inventory),
        Step::Sync => steps::sync(inventory),
        Step::Engine => steps::engine_step(),
        Step::Files => steps::files(choice, args.without_app, failed.contains(&Step::Agent)),
        Step::App => steps::app(inventory),
        Step::Ic if !failed.is_empty() => {
            End::Skipped("Kept, so ic uninstall can finish what is listed below.".to_string())
        }
        Step::Ic => steps::ic(),
    }
}
