/* ASKING A CONSOLE PROGRAM TO STOP, AS ITS CLOSE BUTTON WOULD (2026-11-02). `taskkill` without /F only posts WM_CLOSE to
a program's top-level windows. A console program has none, so taskkill answers "This process can only be terminated
forcefully" and the program never hears anything: every stop of a console game server on the owner's PC was forced, its
save cut off. What a console program does hear is a console control event, and only a process attached to the same
console can send one. This process has no console of its own (it is built for the WINDOWS subsystem), so it attaches to
the target's, ignores the event itself, and sends CTRL_BREAK_EVENT to every process on that console: the program and what
it started there. Node cannot do this: the sender must be attached to the target's console, and the agent's console is
its own.

`--ctrl-break <pid> [--except <pid>]` exits with:
  0  the event was sent;
  2  there was no console to send it on: `pid` is a windowed program, one started with no console at all (Node's
     `detached`), or already gone;
  3  `pid` owns a top-level window, so WM_CLOSE (taskkill without /F) is how it is asked, and a Ctrl-Break on top of
     that would end mid-save a program that handles WM_CLOSE but not the break;
  4  the `--except` process is on the same console, so nothing was sent: the event goes to every process on a console,
     and the agent asking must never be one of them;
  1  anything else, said on stderr.
Windows Input Method windows ("IME", "MSCTFIME UI") are not counted as the program's: Windows makes one for any thread
that touches a window, and they never close the program they belong to. */

use std::ffi::OsString;

#[cfg(windows)]
const EXIT_SENT: u8 = 0;
#[cfg(windows)]
const EXIT_FAILED: u8 = 1;
#[cfg(windows)]
const EXIT_NO_CONSOLE: u8 = 2;
#[cfg(windows)]
const EXIT_HAS_WINDOW: u8 = 3;
#[cfg(windows)]
const EXIT_SHARED: u8 = 4;

#[cfg(any(windows, test))]
const USAGE: &str = "usage: intentic-launch --ctrl-break <pid> [--except <pid>]";

/// Whether this command line asks for a Ctrl-Break rather than a launch.
pub fn asked(argv: &[OsString]) -> bool {
    argv.first().is_some_and(|first| first == "--ctrl-break")
}

/// Who to ask, and who must not hear it.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
pub struct Ask {
    pub pid: u32,
    pub except: Option<u32>,
}

#[cfg(any(windows, test))]
fn pid_of(text: &OsString) -> Result<u32, String> {
    text.to_str()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .filter(|pid| *pid != 0)
        .ok_or_else(|| format!("a process id is a whole number above zero. {USAGE}"))
}

/* The command line minus argv[0], when `asked` is true. */
#[cfg(any(windows, test))]
pub fn parse(argv: &[OsString]) -> Result<Ask, String> {
    match argv {
        [_, pid] => Ok(Ask {
            pid: pid_of(pid)?,
            except: None,
        }),
        [_, pid, flag, except] if flag == "--except" => Ok(Ask {
            pid: pid_of(pid)?,
            except: Some(pid_of(except)?),
        }),
        _ => Err(USAGE.to_string()),
    }
}

/// Window classes that are Windows' own, made for any thread with a window, and never a way to ask a program to close.
#[cfg(any(windows, test))]
pub fn counts_as_its_window(class: &str) -> bool {
    !matches!(class, "IME" | "MSCTFIME UI")
}

#[cfg(windows)]
mod native {
    use std::ffi::c_void;

    pub type Hwnd = *mut c_void;
    pub type EnumProc = unsafe extern "system" fn(Hwnd, isize) -> i32;
    pub type CtrlHandler = unsafe extern "system" fn(u32) -> i32;

    pub const CTRL_BREAK_EVENT: u32 = 1;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn FreeConsole() -> i32;
        pub fn AttachConsole(pid: u32) -> i32;
        pub fn GetConsoleProcessList(list: *mut u32, count: u32) -> u32;
        pub fn SetConsoleCtrlHandler(handler: Option<CtrlHandler>, add: i32) -> i32;
        pub fn GenerateConsoleCtrlEvent(event: u32, group: u32) -> i32;
        pub fn GetLastError() -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn EnumWindows(callback: EnumProc, param: isize) -> i32;
        pub fn GetWindowThreadProcessId(window: Hwnd, pid: *mut u32) -> u32;
        pub fn GetClassNameW(window: Hwnd, name: *mut u16, max: i32) -> i32;
    }
}

/// What EnumWindows is looking for, and whether it found it.
#[cfg(windows)]
struct Search {
    pid: u32,
    found: bool,
}

#[cfg(windows)]
unsafe extern "system" fn each_window(window: native::Hwnd, param: isize) -> i32 {
    // SAFETY: `param` is the &mut Search `owns_window` passed, alive for the whole EnumWindows call.
    let search = &mut *(param as *mut Search);
    let mut owner = 0u32;
    native::GetWindowThreadProcessId(window, &mut owner);
    if owner != search.pid {
        return 1;
    }
    let mut class = [0u16; 64];
    let length = native::GetClassNameW(window, class.as_mut_ptr(), 64);
    let class = String::from_utf16_lossy(&class[..usize::try_from(length).unwrap_or(0)]);
    if counts_as_its_window(&class) {
        search.found = true;
        return 0;
    }
    1
}

/// Whether `pid` owns a top-level window, visible or hidden, that taskkill's WM_CLOSE reaches.
#[cfg(windows)]
fn owns_window(pid: u32) -> bool {
    let mut search = Search { pid, found: false };
    // SAFETY: the callback only reads through the pointer to `search`, which outlives the call.
    unsafe {
        native::EnumWindows(each_window, std::ptr::from_mut(&mut search) as isize);
    }
    search.found
}

/// The processes attached to the console this process is attached to now.
#[cfg(windows)]
fn console_processes() -> Vec<u32> {
    let mut list = vec![0u32; 256];
    // SAFETY: the buffer holds as many ids as the count passed says.
    let count = unsafe { native::GetConsoleProcessList(list.as_mut_ptr(), 256) };
    list.truncate(usize::try_from(count).unwrap_or(0).min(256));
    list
}

/// The handler that keeps this process alive through the event it sends to its own (borrowed) console.
#[cfg(windows)]
unsafe extern "system" fn ignore(_event: u32) -> i32 {
    1
}

#[cfg(windows)]
fn send(ask: &Ask) -> Result<u8, String> {
    let pid = ask.pid;
    if owns_window(pid) {
        eprintln!("pid {pid} has a window: WM_CLOSE asks it, so no Ctrl-Break was sent");
        return Ok(EXIT_HAS_WINDOW);
    }
    // SAFETY: plain console calls with no pointers but the handler, a function that lives as long as the program.
    unsafe {
        native::FreeConsole();
        if native::AttachConsole(pid) == 0 {
            eprintln!(
                "pid {pid} has no console to send a Ctrl-Break on (error {}): a windowed program, one started without a console, or gone",
                native::GetLastError()
            );
            return Ok(EXIT_NO_CONSOLE);
        }
        if let Some(except) = ask.except {
            if console_processes().contains(&except) {
                native::FreeConsole();
                eprintln!("pid {pid} shares its console with pid {except}, which a Ctrl-Break there would end too, so none was sent");
                return Ok(EXIT_SHARED);
            }
        }
        native::SetConsoleCtrlHandler(Some(ignore), 1);
        // Group 0: every process attached to this console, which is the program and what it started there.
        let sent = native::GenerateConsoleCtrlEvent(native::CTRL_BREAK_EVENT, 0);
        let error = native::GetLastError();
        // The event is delivered on a thread of each process; leaving the console at once has been seen to lose it.
        std::thread::sleep(std::time::Duration::from_millis(100));
        native::FreeConsole();
        if sent == 0 {
            return Err(format!(
                "could not send Ctrl-Break on pid {pid}'s console (error {error})"
            ));
        }
    }
    Ok(EXIT_SENT)
}

#[cfg(windows)]
pub fn main(argv: &[OsString]) -> std::process::ExitCode {
    use std::process::ExitCode;
    match parse(argv).and_then(|ask| send(&ask)) {
        Ok(code) => ExitCode::from(code),
        Err(why) => {
            eprintln!("{why}");
            ExitCode::from(EXIT_FAILED)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{asked, counts_as_its_window, parse, Ask};
    use std::ffi::OsString;

    fn argv(parts: &[&str]) -> Vec<OsString> {
        parts.iter().map(OsString::from).collect()
    }

    #[test]
    fn takes_a_pid_and_who_must_not_hear_it() {
        assert!(asked(&argv(&["--ctrl-break", "4120"])));
        assert!(!asked(&argv(&["--log", "x", "--", "agent"])));
        assert_eq!(
            parse(&argv(&["--ctrl-break", "4120"])),
            Ok(Ask {
                pid: 4120,
                except: None
            })
        );
        assert_eq!(
            parse(&argv(&["--ctrl-break", "4120", "--except", "88"])),
            Ok(Ask {
                pid: 4120,
                except: Some(88)
            })
        );
    }

    #[test]
    fn refuses_what_is_not_one_pid() {
        assert!(parse(&argv(&["--ctrl-break"])).is_err());
        assert!(parse(&argv(&["--ctrl-break", "0"])).is_err());
        assert!(parse(&argv(&["--ctrl-break", "-3"])).is_err());
        assert!(parse(&argv(&["--ctrl-break", "notepad"])).is_err());
        assert!(parse(&argv(&["--ctrl-break", "1", "2"])).is_err());
        assert!(parse(&argv(&["--ctrl-break", "1", "--except"])).is_err());
        assert!(parse(&argv(&["--ctrl-break", "1", "--except", "x"])).is_err());
    }

    /* The input-method windows every windowed thread gets would otherwise read as "it has a window, WM_CLOSE asks it". */
    #[test]
    fn does_not_count_input_method_windows() {
        assert!(!counts_as_its_window("IME"));
        assert!(!counts_as_its_window("MSCTFIME UI"));
        assert!(counts_as_its_window("ConsoleWindowClass"));
        assert!(counts_as_its_window("GameServerHiddenWindow"));
    }
}
