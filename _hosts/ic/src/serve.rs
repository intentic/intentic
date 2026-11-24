use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::answer::Captured;

/* `ic serve --stdio`: THE MACHINE AGENT'S PERIODIC READS, ANSWERED BY ONE PROCESS. The agent asks ic the same few
questions every minute (what swaps are going on, how full the engine's disk is, what runs here), and on Windows a process
is dear to start: the CPU audit of 2026-11-24 measured 182 ms of CPU for one `ic sandbox list --json`. So the agent keeps
one of these per agent and sends it the argv it would have spawned, one JSON line each:

    → {"id": 7, "args": ["sandbox", "swaps", "--json"]}
    ← {"id": 7, "code": 0, "stdout": "[]\n", "stderr": "", "output": "[]\n"}

Each answer is what the per-call verb prints, byte for byte: the request runs through main.rs's own `execute`, the same
code from argv to exit code, with every write the crate makes kept (answer.rs) instead of printed. `output` is both
streams in the order they were written, as a caller reading them as one sees them. A request for anything not on VERBS
answers `{"id", "error"}` and runs nothing, as does a line that is not a request (with `"id": null` when it has none).

Only verbs that read are served, and only those that keep no state of the process between runs: a verb that sets a
process-wide switch (`--json` flows that send human lines to stderr for the rest of the run), asks a person, or exits the
process from inside would answer the next request differently from a fresh ic, or end this one. One request runs at a
time, in the order they came: the agent sends the next only once the last is answered, and spawns a per-call ic for
anything it needs meanwhile. The first line out is the hello, which is how an agent tells this ic serves at all (an
older one refuses `serve` as a usage error) and which verbs it serves. Stdin closing ends the loop, exit 0: an agent
that goes away takes its server with it. */

/// The protocol's version, said in the hello; a change to the lines' shape is a new number.
pub const PROTOCOL: u64 = 1;

/// Every argv served, exactly as the agent spawns it.
pub const VERBS: &[&[&str]] = &[
    &["sandbox", "list", "--json"],
    &["sandbox", "swaps", "--json"],
    &["engine", "disk", "--json"],
];

pub fn hello() -> Value {
    json!({ "serve": PROTOCOL, "verbs": VERBS })
}

fn served(args: &[String]) -> bool {
    VERBS.iter().any(|verb| {
        verb.len() == args.len() && verb.iter().zip(args).all(|(want, got)| want == got)
    })
}

/// The answer to one request line, running it through `run` when it is a served verb. Pure but for `run`.
pub fn answer(line: &str, run: &mut dyn FnMut(&[String]) -> (i32, Captured)) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => return json!({ "id": null, "error": format!("not a request: {error}") }),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(args) = request["args"].as_array().and_then(|args| {
        args.iter()
            .map(|arg| arg.as_str().map(str::to_string))
            .collect::<Option<Vec<String>>>()
    }) else {
        return json!({ "id": id, "error": "a request carries `args`, a list of strings." });
    };
    if !served(&args) {
        return json!({
            "id": id,
            "error": format!("ic serve does not answer `ic {}`; run it as its own process.", args.join(" ")),
        });
    }
    let (code, kept) = run(&args);
    json!({
        "id": id,
        "code": code,
        "stdout": String::from_utf8_lossy(&kept.stdout),
        "stderr": String::from_utf8_lossy(&kept.stderr),
        "output": String::from_utf8_lossy(&kept.output),
    })
}

/// The loop over any pair of streams: the hello, then one answer per non-empty line, until `input` ends.
pub fn serve_lines(
    input: impl BufRead,
    output: &mut impl Write,
    run: &mut dyn FnMut(&[String]) -> (i32, Captured),
) -> std::io::Result<()> {
    writeln!(output, "{}", hello())?;
    output.flush()?;
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        writeln!(output, "{}", answer(&line, run))?;
        output.flush()?;
    }
    Ok(())
}

/// One served argv, as `ic <args>` runs it: through main's `execute`, every write kept. A panic is the exit code a
/// panicking ic has (101), and this process goes on to the next request.
fn run_one(args: &[String]) -> (i32, Captured) {
    use clap::Parser as _;
    crate::engine::readopt();
    crate::answer::capture(|| {
        let argv = std::iter::once("ic".to_string()).chain(args.iter().cloned());
        match crate::Cli::try_parse_from(argv) {
            Ok(cli) => {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| crate::execute(cli)))
                    .unwrap_or(101)
            }
            Err(error) => {
                // Unreachable for a served verb; said the way clap would say it, on stderr.
                let _ = write!(crate::answer::stderr(), "{error}");
                2
            }
        }
    })
}

/// `ic serve --stdio`, answering its exit code: 0 once stdin closes.
pub fn run(stdio: bool) -> i32 {
    if !stdio {
        crate::ui::error("ic serve speaks over stdin and stdout only: run `ic serve --stdio`.");
        return 2;
    }
    let stdin = std::io::stdin();
    // Answers go straight to the process's stdout: a verb's own writes are kept while it runs (answer.rs), so nothing
    // else lands between two answers.
    let mut out = std::io::stdout();
    match serve_lines(stdin.lock(), &mut out, &mut run_one) {
        Ok(()) => 0,
        // The agent went away mid-answer: nobody is left to tell.
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(args: &[String]) -> (i32, Captured) {
        let said = format!("[\"{}\"]\n", args.join(" "));
        (
            0,
            Captured {
                stdout: said.clone().into_bytes(),
                stderr: b"intentic: note\n".to_vec(),
                output: format!("{said}intentic: note\n").into_bytes(),
            },
        )
    }

    fn served_over(input: &str) -> Vec<Value> {
        let mut out: Vec<u8> = Vec::new();
        serve_lines(input.as_bytes(), &mut out, &mut fake).expect("served");
        String::from_utf8(out)
            .expect("utf-8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("each line is JSON"))
            .collect()
    }

    #[test]
    fn the_first_line_is_the_hello_naming_every_served_verb() {
        let lines = served_over("");
        assert_eq!(
            lines.len(),
            1,
            "an input that ends at once is the hello alone, and the loop ends"
        );
        assert_eq!(lines[0]["serve"], json!(PROTOCOL));
        assert_eq!(lines[0]["verbs"][1], json!(["sandbox", "swaps", "--json"]));
    }

    #[test]
    fn a_served_verb_is_answered_with_its_id_code_and_both_streams() {
        let lines = served_over("{\"id\":7,\"args\":[\"sandbox\",\"swaps\",\"--json\"]}\n\n{\"id\":\"b\",\"args\":[\"engine\",\"disk\",\"--json\"]}\n");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1]["id"], json!(7));
        assert_eq!(lines[1]["code"], json!(0));
        assert_eq!(lines[1]["stdout"], json!("[\"sandbox swaps --json\"]\n"));
        assert_eq!(lines[1]["stderr"], json!("intentic: note\n"));
        assert_eq!(
            lines[1]["output"],
            json!("[\"sandbox swaps --json\"]\nintentic: note\n")
        );
        assert_eq!(lines[2]["id"], json!("b"));
    }

    #[test]
    fn an_unknown_verb_is_an_error_and_runs_nothing() {
        let mut ran = 0;
        let mut run = |args: &[String]| {
            ran += 1;
            fake(args)
        };
        let refused = answer(
            "{\"id\":3,\"args\":[\"sandbox\",\"remove\",\"a\",\"-y\"]}",
            &mut run,
        );
        assert_eq!(refused["id"], json!(3));
        assert!(refused["error"]
            .as_str()
            .unwrap()
            .contains("ic sandbox remove a -y"));
        assert!(refused.get("code").is_none());
        // A served verb with one flag more is another command.
        let longer = answer(
            "{\"id\":4,\"args\":[\"sandbox\",\"list\",\"--json\",\"--x\"]}",
            &mut run,
        );
        assert!(longer["error"].is_string());
        assert_eq!(ran, 0);
    }

    #[test]
    fn a_line_that_is_not_a_request_is_an_error_and_the_loop_goes_on() {
        let lines = served_over(
            "not json\n{\"id\":1}\n{\"id\":2,\"args\":[\"sandbox\",\"list\",\"--json\"]}\n",
        );
        assert_eq!(lines[1]["id"], Value::Null);
        assert!(lines[1]["error"]
            .as_str()
            .unwrap()
            .starts_with("not a request"));
        assert_eq!(lines[2]["id"], json!(1));
        assert!(lines[2]["error"].is_string());
        assert_eq!(lines[3]["code"], json!(0));
    }
}
