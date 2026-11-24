use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/* `ic serve --stdio` against the built binary: each answer is what the same argv prints as its own process, and the
server ends when its stdin does. The home is an empty one of the test's own, so the answers are this test's alone. */

fn ic(home: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ic"));
    command
        .env("INTENTIC_HOME", home)
        .env_remove("INTENTIC_UI")
        .env_remove("INTENTIC_PLAIN");
    command
}

fn per_call(home: &std::path::Path, args: &[&str]) -> (i32, String, String) {
    let ran = ic(home).args(args).output().expect("ic runs");
    (
        ran.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&ran.stdout).into_owned(),
        String::from_utf8_lossy(&ran.stderr).into_owned(),
    )
}

#[test]
fn every_served_verb_answers_what_its_own_process_prints_and_stdin_closing_ends_the_server() {
    let home = tempfile::tempdir().expect("a home");
    let verbs: [&[&str]; 3] = [
        &["sandbox", "swaps", "--json"],
        &["engine", "disk", "--json"],
        &["sandbox", "list", "--json"],
    ];
    let mut server = ic(home.path())
        .args(["serve", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("ic serve starts");
    let mut input = server.stdin.take().expect("stdin");
    let mut output = BufReader::new(server.stdout.take().expect("stdout"));
    let mut line = String::new();
    output.read_line(&mut line).expect("the hello");
    let hello: serde_json::Value = serde_json::from_str(&line).expect("the hello is JSON");
    assert_eq!(hello["serve"], 1);

    for (id, args) in verbs.iter().enumerate() {
        let request = serde_json::json!({ "id": id, "args": args });
        writeln!(input, "{request}").expect("a request");
        line.clear();
        output.read_line(&mut line).expect("an answer");
        let served: serde_json::Value = serde_json::from_str(&line).expect("the answer is JSON");
        let (code, stdout, stderr) = per_call(home.path(), args);
        assert_eq!(served["id"], id, "{args:?}");
        assert_eq!(served["code"], code, "{args:?}");
        assert_eq!(served["stdout"], stdout.as_str(), "{args:?}");
        assert_eq!(served["stderr"], stderr.as_str(), "{args:?}");
    }

    writeln!(
        input,
        "{}",
        serde_json::json!({ "id": "x", "args": ["sandbox", "remove", "a", "-y"] })
    )
    .expect("a request");
    line.clear();
    output.read_line(&mut line).expect("an answer");
    let refused: serde_json::Value = serde_json::from_str(&line).expect("JSON");
    assert_eq!(refused["id"], "x");
    assert!(refused["error"].is_string());

    drop(input);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = server.try_wait().expect("waited") {
            assert_eq!(status.code(), Some(0));
            break;
        }
        assert!(Instant::now() < deadline, "ic serve outlived its stdin");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn serve_without_stdio_is_refused() {
    let home = tempfile::tempdir().expect("a home");
    let ran = ic(home.path()).arg("serve").output().expect("ic runs");
    assert_eq!(ran.status.code(), Some(2));
}
