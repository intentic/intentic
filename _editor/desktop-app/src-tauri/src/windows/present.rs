/* WHO MAY CHANGE WHAT THE READER SEES (2026-10-26). The reader is never moved out of the view they are in by anything
 * the app or a page does on its own: a sign-in coming back, this PC's own setup, a sandbox's setup, a folder's, a
 * Docker start, a recreate, a fix, a sync, a repair. Each runs where the reader already is, a tile in that face's rail
 * and a page in its place (processes.rs, the web's shell/rail/processes/), and what it needs of the reader is asked
 * there, or by the system's notification while nobody is looking (processes.rs `attend`). Only a press that names a
 * destination puts a face in the frame, takes a face to one of its screens, or brings the frame or a window forward:
 * the tray's rows, This computer and Back to the workspace, a launch, a second launch, a notification, the shell's keys,
 * a window the reader opens again, a page's own Open.
 *
 * That is held by the type below rather than by reading every caller: every function that does any of it
 * (windows.rs `swap_in`, `show_*`, `raise_window`, local.rs `open_home_later`) takes a [`Press`], and a Press says who
 * pressed. A process has no press to hand on, so a new caller in one does not compile without inventing a reason it
 * would have to defend here; the source test below keeps the modules that run processes from inventing one.
 *
 * _(2026-10-26) Until now the app swapped This device in over the workspace for a setup handed over, a sign-in that
 * began on a folder, a run that stopped or asked something, a parked setup or a sleeping engine at launch, a recreate,
 * a fix and a sync; and swapped the workspace in for a sign-in's return, a finished setup, a Docker that woke, a
 * folder's first task. A reader who signed in on Home was taken off it to a card about preparing their PC._ */

/// Who pressed: every way a reader asks for a face, a screen of one, or a window, by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Asked {
    /// A row of the tray's menu.
    Tray,
    /// A launch of the app: its first face (lib.rs `opening`), the reader's last one.
    Launch,
    /// The app started again while it runs, bare: what the tray's "Open Intentic" opens.
    SecondLaunch,
    /// A page's press that names where it goes: This computer, Back to the workspace, Manage on this computer, This
    /// computer's sandboxes, Open on a process's page.
    Page,
    /// A press on one of the app's notifications.
    Notification,
    /// Intentic OS's keys and bar (shell.rs).
    Shell,
    /// A window the reader asked for again (a document opened twice, a folder another window shows, a × held for
    /// unsaved edits): brought back in front of them.
    Window,
}

/// A reader's press that names where to go. The only way to change the face, a face's screen, or the window in front.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Press {
    /// What was pressed: for the reader of a caller, and of a debugger, since nothing decides by it.
    _asked: Asked,
}

impl Press {
    /// Said only where the reader pressed, with what they pressed.
    pub const fn by(asked: Asked) -> Self {
        Press { _asked: asked }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The modules that run processes never make a press, never swap a face and never raise a window: what they have to
    /// say goes to the process list (processes.rs), which draws it in whichever face the reader is in. A press the
    /// reader makes on a process's page is answered in processes.rs `act`, the one place a process's Open is pressed.
    #[test]
    fn a_process_never_moves_the_reader() {
        const MOVES: &[&str] = &[
            "Press::by(",
            "swap_in(",
            "show_home(",
            "show_home_at(",
            "show_home_route(",
            "show_device(",
            "show_workspace(",
            "show_workspace_at(",
            "show_workspace_from(",
            "show_last_face(",
            "show_machine_face_from(",
            "raise_window(",
            "open_home_later(",
            "frame::show(",
            "set_focus(",
            "unminimize(",
            "open_in_place(",
            "local::navigate(",
        ];
        let processes = [
            ("auth.rs", include_str!("../auth.rs")),
            ("fix.rs", include_str!("../fix.rs")),
            ("folder_setup.rs", include_str!("../folder_setup.rs")),
            ("onboarding.rs", include_str!("../onboarding.rs")),
            ("first_task.rs", include_str!("../first_task.rs")),
            ("repair/mod.rs", include_str!("../repair/mod.rs")),
            ("windows/setup.rs", include_str!("setup.rs")),
            ("windows/warmth.rs", include_str!("warmth.rs")),
            ("windows/links.rs", include_str!("links.rs")),
        ];
        for (file, source) in processes {
            // The code before its tests: a test may name what it checks.
            let code = source.split("#[cfg(test)]").next().unwrap_or(source);
            for moves in MOVES {
                // links.rs answers presses too: This computer, Back to the workspace and the machine face, each named.
                let allowed = file == "windows/links.rs"
                    && matches!(
                        *moves,
                        "Press::by(" | "show_home_at(" | "show_device(" | "show_machine_face_from("
                    );
                assert!(
                    allowed || !code.contains(moves),
                    "{file} calls {moves}: a process moves the reader there"
                );
            }
        }
        // And in links.rs, each press is a link the reader's press sent: never one a process sends.
        let links = include_str!("links.rs");
        let links = links.split("#[cfg(test)]").next().unwrap_or(links);
        assert_eq!(
            links.matches("Press::by(").count(),
            3,
            "links.rs makes a press only for its three named destinations"
        );
    }

    #[test]
    fn a_press_says_who_pressed() {
        assert!(format!("{:?}", Press::by(Asked::Tray)).contains("Tray"));
    }
}
