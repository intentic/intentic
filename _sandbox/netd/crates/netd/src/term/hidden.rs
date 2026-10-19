//! A password typed into a person's own terminal, noticed so Passwords can remember it (the daemon's
//! `terminal-capture.ts`, the keyring's `remember.sandbox` switch). Only the editor's sessions (`web-…`) are watched,
//! never an agent's, and only this far: the pane's output is kept as a short tail, and when the person starts typing
//! after output that stopped on a password-ish question, the pane's tty is asked whether echo is off (a program is
//! reading a hidden line). If it is, what is typed up to Enter is edited here as a terminal would (backspace, Ctrl-U,
//! Ctrl-C) and handed on once, as `ToNode::HiddenLine`, then dropped. Nothing here logs a keystroke. Whether any of the
//! owner's computers keeps it, and what it is called, the daemon decides.

use std::ffi::CString;

/// The editor's own sessions: the person types there. An agent's sessions are never watched.
pub const WEB_SESSION_PREFIX: &str = "web-";

// Enough output to hold the question; a pane's history is not this module's to keep.
const TAIL_MAX: usize = 2048;
// A hidden line longer than any password: past it the line is given up, not grown.
const LINE_MAX: usize = 4096;
// A prompt line longer than this is not a question.
const PROMPT_MAX: usize = 200;

/// A line typed with echo off, entered: the question it answered and what was typed.
#[derive(Debug, PartialEq, Eq)]
pub struct Entered {
    pub prompt: String,
    pub value: String,
}

/// One session's watch over its pane.
#[derive(Default)]
pub struct HiddenTap {
    tail: Vec<u8>,
    typing: Option<Typing>,
}

struct Typing {
    prompt: String,
    line: Vec<char>,
}

/// The last line of the pane's output when it stopped short of a newline: the question a program is waiting on.
pub fn prompt_of(tail: &[u8]) -> Option<String> {
    if tail.is_empty() || tail.ends_with(b"\n") || tail.ends_with(b"\r") {
        return None;
    }
    let text = String::from_utf8_lossy(tail);
    let last = text.rsplit(['\n', '\r']).next().unwrap_or_default();
    let plain = strip_escapes(last);
    let prompt = plain.trim();
    (!prompt.is_empty() && prompt.chars().count() <= PROMPT_MAX).then(|| prompt.to_owned())
}

/// A question asking for something secret, and not a one-time code: what is typed after it is worth remembering. The
/// same words as the daemon's `remembersPrompt` (prompt-capture.ts), which asks again before anything is kept; here it
/// only decides whether the tty is asked and the line collected at all.
pub fn asks_for_secret(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let secret = [
        "pass",
        "pwd",
        "secret",
        "passwort",
        "kennwort",
        "contraseña",
        "mot de passe",
        "hasło",
    ]
    .iter()
    .any(|word| lower.contains(word));
    let one_time = [
        "otp",
        "2fa",
        "mfa",
        "totp",
        "one-time",
        "one time",
        "onetime",
        "verification",
        "verify",
        "authenticator",
        "security code",
        "passcode",
        "pin",
        "digit",
        "yubikey",
        "touch",
    ]
    .iter()
    .any(|word| lower.contains(word));
    secret && !one_time
}

// Colours and cursor moves out of a prompt's words: CSI sequences (`ESC [ … final`) and other two-byte escapes.
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            if !c.is_control() {
                out.push(c);
            }
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}

/// Whether the terminal at `tty` has echo off. Asked of the tty itself (`tcgetattr`), never of a process; anything
/// that cannot be read is "no", so nothing is captured on a guess.
pub fn echo_off(tty: &str) -> bool {
    if !tty.starts_with("/dev/") {
        return false;
    }
    let Ok(path) = CString::new(tty) else {
        return false;
    };
    // SAFETY: `path` is a valid NUL-terminated string for the call's duration; the descriptor is closed below on every
    // path, and `termios` is plain data that `tcgetattr` fills before it is read.
    unsafe {
        let fd = libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_NOCTTY | libc::O_NONBLOCK | libc::O_CLOEXEC,
        );
        if fd < 0 {
            return false;
        }
        let mut termios: libc::termios = std::mem::zeroed();
        let read = libc::tcgetattr(fd, &mut termios);
        libc::close(fd);
        read == 0 && termios.c_lflag & libc::ECHO == 0
    }
}

impl HiddenTap {
    // The question given up: what was typed is dropped, and the next keystroke is the shell's again.
    fn give_up(&mut self) -> Option<Entered> {
        self.typing = None;
        self.tail.clear();
        None
    }

    /// What the pane drew, kept as a short tail.
    pub fn output(&mut self, bytes: &[u8]) {
        self.tail.extend_from_slice(bytes);
        if self.tail.len() > TAIL_MAX {
            let cut = self.tail.len() - TAIL_MAX;
            self.tail.drain(..cut);
        }
    }

    /// What the person typed. `hidden` is asked only when typing starts after a password-ish question: whether the
    /// pane's tty has echo off right now. The entered line, once, when Enter ends it.
    pub fn input(&mut self, bytes: &[u8], hidden: impl FnOnce() -> bool) -> Option<Entered> {
        if self.typing.is_none() {
            let prompt = prompt_of(&self.tail).filter(|prompt| asks_for_secret(prompt))?;
            if !hidden() {
                return None;
            }
            self.typing = Some(Typing {
                prompt,
                line: Vec::new(),
            });
        }
        let typing = self.typing.as_mut()?;
        // As the tty's canonical mode edits a line: Backspace (DEL or ^H) drops a character, ^U the line, ^W the last
        // word; ^C, ^Z, ^D on an empty line, or an escape sequence (an arrow key: the program is no longer reading a
        // line) give the question up; Enter ends it.
        for c in String::from_utf8_lossy(bytes).chars() {
            match c {
                '\r' | '\n' => {
                    let done = self.typing.take()?;
                    self.tail.clear();
                    let value: String = done.line.into_iter().collect();
                    return (!value.is_empty()).then_some(Entered {
                        prompt: done.prompt,
                        value,
                    });
                }
                '\u{3}' | '\u{1a}' | '\u{1b}' => return self.give_up(),
                '\u{4}' if typing.line.is_empty() => return self.give_up(),
                '\u{7f}' | '\u{8}' => {
                    typing.line.pop();
                }
                '\u{15}' => typing.line.clear(),
                '\u{17}' => {
                    while typing.line.last().is_some_and(|c| c.is_whitespace()) {
                        typing.line.pop();
                    }
                    while typing.line.last().is_some_and(|c| !c.is_whitespace()) {
                        typing.line.pop();
                    }
                }
                c if c.is_control() => {}
                c => {
                    if typing.line.len() >= LINE_MAX {
                        return self.give_up();
                    }
                    typing.line.push(c);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tap_after(output: &str) -> HiddenTap {
        let mut tap = HiddenTap::default();
        tap.output(output.as_bytes());
        tap
    }

    #[test]
    fn the_question_is_the_last_line_left_without_a_newline() {
        assert_eq!(
            prompt_of(b"npm notice\r\nPassword: ").as_deref(),
            Some("Password:")
        );
        assert_eq!(
            prompt_of(b"\x1b[1m[sudo] password for radar:\x1b[0m ").as_deref(),
            Some("[sudo] password for radar:")
        );
        assert_eq!(prompt_of(b"Password:\r\n"), None);
        assert_eq!(prompt_of(b""), None);
    }

    #[test]
    fn a_one_time_code_is_not_a_secret_worth_keeping() {
        assert!(asks_for_secret("Password:"));
        assert!(asks_for_secret(
            "Enter passphrase for key '/root/.ssh/id_ed25519':"
        ));
        assert!(!asks_for_secret("Enter your one-time password:"));
        assert!(!asks_for_secret("2FA code:"));
        assert!(!asks_for_secret("Username:"));
        assert!(asks_for_secret("Passwort:"));
        assert!(asks_for_secret("Podaj hasło:"));
        assert!(!asks_for_secret("PIN:"));
        assert!(!asks_for_secret("Enter the 6-digit code:"));
    }

    #[test]
    fn a_hidden_line_is_edited_as_a_terminal_would_and_handed_on_once() {
        let mut tap = tap_after("Password: ");
        assert_eq!(tap.input(b"hunx", || true), None);
        assert_eq!(
            tap.input(b"\x7fter2", || panic!("asked once, when typing starts")),
            None
        );
        assert_eq!(
            tap.input(b"\r", || panic!("asked once")),
            Some(Entered {
                prompt: "Password:".into(),
                value: "hunter2".into()
            })
        );
        // The question is spent: typing after it is the shell's again.
        assert_eq!(tap.input(b"ls\r", || true), None);
    }

    #[test]
    fn ctrl_u_erases_the_line_and_ctrl_w_the_last_word() {
        let mut tap = tap_after("Password: ");
        assert_eq!(
            tap.input(b"wrong\x15right one\x17two\r", || true),
            Some(Entered {
                prompt: "Password:".into(),
                value: "right two".into()
            })
        );
    }

    #[test]
    fn ctrl_c_ctrl_z_and_an_arrow_key_give_the_question_up() {
        for give_up in [&b"abc\x03"[..], b"abc\x1a", b"abc\x1b[D"] {
            let mut tap = tap_after("Password: ");
            assert_eq!(tap.input(give_up, || true), None);
            assert_eq!(tap.input(b"def\r", || true), None);
        }
    }

    #[test]
    fn ctrl_d_gives_up_only_on_an_empty_line() {
        assert_eq!(tap_after("Password: ").input(b"\x04", || true), None);
        let mut tap = tap_after("Password: ");
        assert_eq!(
            tap.input(b"ab\x04c\r", || true),
            Some(Entered {
                prompt: "Password:".into(),
                value: "abc".into()
            })
        );
    }

    #[test]
    fn nothing_is_kept_where_echo_is_on_or_the_question_is_not_one() {
        assert_eq!(tap_after("Password: ").input(b"visible\r", || false), None);
        assert_eq!(tap_after("$ ").input(b"echo hi\r", || true), None);
    }

    #[test]
    fn an_unreadable_tty_reads_as_echo_on() {
        assert!(!echo_off("/dev/does-not-exist"));
        assert!(!echo_off("not-a-tty"));
    }
}
