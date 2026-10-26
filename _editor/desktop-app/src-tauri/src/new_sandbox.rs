//! A NEW SANDBOX FROM THIS COMPUTER (2026-10-26), the web's localProcessHost.ts `LocalNewSandboxHost`.
//!
//! Devices' "Set one up", the switcher's "Add a sandbox" and a PC that cannot run a sandbox's "use a machine of ours" make
//! the sandbox here, in the window the reader pressed in, as Home makes one in the workspace. Until now each opened the
//! workspace on its setup page, taking the reader out of This computer to do it (windows/present.rs). The app asks the
//! platform itself, with the workspace's session (account.rs `platform_post`, fixed paths only), then either runs the
//! sandbox on this computer as a handed-over setup does (windows/links.rs `park_setup`, out of sight, the main window's
//! run reported as `sandbox-setup:<id>`) or starts a machine of ours for it and follows it until it reports in.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Webview};

use crate::account::{platform_get, platform_post, Answered};
use crate::processes::ProcessReport;
use crate::setup_link::SetupArgs;

/// Where a new sandbox can run from here, read now (`LocalNewSandboxOffers`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offers {
    pub here: bool,
    pub hosted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_problem: Option<String>,
}

/// What a platform's machine offer says, in the reader's words where it cannot start one now. Pure.
fn hosted_of(offer: &Value) -> (bool, Option<String>) {
    if offer["enabled"].as_bool() != Some(true) {
        return (false, None);
    }
    let problem = if offer["needsGoogle"].as_bool() == Some(true) {
        Some("A machine of ours needs a Google sign-in on this account. Link one in the workspace's settings.")
    } else if offer["suspended"].as_bool() == Some(true) {
        Some("Machines of ours are switched off for this account.")
    } else if offer["full"].as_bool() == Some(true) {
        Some("All of our machines are in use right now. Try again in a little while.")
    } else if offer["remaining"].as_u64().unwrap_or(0) == 0 {
        Some("This account has no machine of ours left to start.")
    } else {
        None
    };
    (problem.is_none(), problem.map(str::to_string))
}

/// Whether this computer runs a sandbox at all: the app's setup runs on Windows and Linux.
fn runs_here() -> bool {
    cfg!(any(target_os = "windows", target_os = "linux"))
}

const SIGNED_OUT: &str = "Sign in first: a sandbox is made on your account.";

/// Where a new sandbox made from this window can run.
#[tauri::command]
pub async fn new_sandbox_offers(app: AppHandle, window: Webview) -> Result<Offers, String> {
    let address = platform_get(&app, &window, "/rpc/sandbox/address-offer").await?;
    let hosted = platform_get(&app, &window, "/rpc/sandbox/hosted-offer").await?;
    let (Answered::Json { body: address, .. }, Answered::Json { body: hosted, .. }) =
        (address, hosted)
    else {
        return Err(SIGNED_OUT.to_string());
    };
    let (hosted, hosted_problem) = hosted_of(&hosted);
    Ok(Offers {
        here: runs_here() && address["enabled"].as_bool() == Some(true),
        hosted,
        hosted_problem,
    })
}

/// The folder a sandbox made here keeps in sync, as the workspace's own handover names it (sandbox-contract's
/// `syncFolder`): `~/intentic/<name>-<the address's id>`. Pure.
fn sync_folder(name: &str, hostname: Option<&str>) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "sandbox" } else { slug };
    let id = hostname
        .and_then(|host| host.split('.').next())
        .filter(|label| !label.is_empty() && *label != "sandbox-")
        .map(|label| label.strip_prefix("sandbox-").unwrap_or(label));
    match id {
        Some(id) => format!("~/intentic/{slug}-{id}"),
        None => format!("~/intentic/{slug}"),
    }
}

/// The sandbox's row, made on the account: its id and the token a machine of ours is started with.
async fn make_row(
    app: &AppHandle,
    window: &Webview,
    name: &str,
) -> Result<(String, Option<String>), String> {
    match platform_post(app, window, "/rpc/sandbox/create", &json!({ "name": name })).await? {
        Answered::SignedOut => Err(SIGNED_OUT.to_string()),
        Answered::Json { status, body } if (200..300).contains(&status) => {
            let id = body["id"]
                .as_str()
                .filter(|id| crate::setup_link::is_sandbox_id(id))
                .ok_or("The platform's answer didn't name the new sandbox. Updating Intentic may fix this.")?;
            Ok((id.to_string(), body["token"].as_str().map(str::to_string)))
        }
        Answered::Json { status, body } => Err(crate::project::refused_by(status, &body)),
    }
}

/// Makes the sandbox under `name` and starts it where it was picked; its run is `sandbox-setup:<id>` on both faces'
/// rails from then on. Rejects with the platform's words.
#[tauri::command]
pub async fn new_sandbox_create(
    app: AppHandle,
    window: Webview,
    name: String,
    on: String,
) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err("A sandbox's name is one to sixty characters.".to_string());
    }
    let (sandbox_id, token) = make_row(&app, &window, &name).await?;
    match on.as_str() {
        "here" => run_here(&app, &window, &sandbox_id, &name).await?,
        "hosted" => start_hosted(&app, &window, &sandbox_id, &name, token).await?,
        _ => {
            return Err("A new sandbox runs on this computer or on a machine of ours.".to_string())
        }
    }
    Ok(json!({ "sandboxId": sandbox_id }))
}

/// On this computer: a code minted for the row, and the setup handed to the main window as a setup link hands it.
async fn run_here(
    app: &AppHandle,
    window: &Webview,
    sandbox_id: &str,
    name: &str,
) -> Result<(), String> {
    let minted = crate::project::mint_code(app, window, sandbox_id, None).await?;
    let (code, hostname) = match crate::project::minted_code(minted) {
        crate::project::Minted::Code { code, hostname, .. } => (code, hostname),
        crate::project::Minted::SignedOut => return Err(SIGNED_OUT.to_string()),
        crate::project::Minted::Refused(why) => return Err(why),
    };
    let mut starting = ProcessReport::of("sandbox-setup", sandbox_id, "running");
    starting.subject = Some(name.to_string());
    starting.sandbox_id = Some(sandbox_id.to_string());
    crate::processes::report(app, starting);
    crate::windows::links::park_setup(
        app,
        SetupArgs {
            code,
            sandbox_id: Some(sandbox_id.to_string()),
            name: Some(name.to_string()),
            cf_token: None,
            sync_dir: Some(sync_folder(name, hostname.as_deref())),
            platform_url: None,
            project: None,
            slug: None,
            minted_at: None,
            profile: None,
        },
    );
    Ok(())
}

/// A machine of ours for a sandbox this computer was setting up (src/device/setup.ts `setUpElsewhere`): the same row, its
/// token read off the account's list, started and followed under the same process id. A refusal is said on that tile,
/// since the setup it replaces has already let go of it.
#[tauri::command]
pub async fn new_sandbox_hosted(
    app: AppHandle,
    window: Webview,
    sandbox_id: String,
    name: String,
) -> Result<(), String> {
    if !crate::setup_link::is_sandbox_id(&sandbox_id) {
        return Err("That is not a sandbox of this account.".to_string());
    }
    let token = match platform_get(&app, &window, "/rpc/sandbox/list").await? {
        Answered::Json { status, body } if (200..300).contains(&status) => {
            token_of(&body, &sandbox_id)
        }
        _ => None,
    };
    if let Err(why) = start_hosted(&app, &window, &sandbox_id, &name, token).await {
        let mut refused = hosted_report(&sandbox_id, &name, "failed");
        refused.failure = Some(why.chars().take(600).collect());
        refused.actions = vec!["dismiss".into()];
        crate::processes::report(&app, refused);
        return Err(why);
    }
    Ok(())
}

/// The owner's token for `sandbox_id`, as the account's list carries it. Pure.
fn token_of(list: &Value, sandbox_id: &str) -> Option<String> {
    let rows = list.as_array().or_else(|| list["sandboxes"].as_array())?;
    rows.iter()
        .find(|row| row["id"].as_str() == Some(sandbox_id))
        .and_then(|row| row["token"].as_str())
        .map(str::to_string)
}

/// How long a machine of ours is followed before its tile says it has not reported in.
const HOSTED_WAIT: Duration = Duration::from_secs(10 * 60);
const HOSTED_POLL: Duration = Duration::from_secs(5);

fn hosted_report(sandbox_id: &str, name: &str, state: &str) -> ProcessReport {
    let mut report = ProcessReport::of("sandbox-setup", sandbox_id, state);
    report.subject = Some(name.to_string());
    report.sandbox_id = Some(sandbox_id.to_string());
    report.step = Some("hosted".into());
    report
}

/// On a machine of ours: started, then followed on the account's list until the sandbox reports in.
async fn start_hosted(
    app: &AppHandle,
    window: &Webview,
    sandbox_id: &str,
    name: &str,
    token: Option<String>,
) -> Result<(), String> {
    let token = token.ok_or("The platform's answer carried no token to start a machine with. Updating Intentic may fix this.")?;
    let asked = platform_post(
        app,
        window,
        "/rpc/sandbox/hosted-provision",
        &json!({ "sandboxId": sandbox_id, "token": token }),
    )
    .await?;
    match asked {
        Answered::SignedOut => return Err(SIGNED_OUT.to_string()),
        Answered::Json { status, body } if !(200..300).contains(&status) => {
            return Err(crate::project::refused_by(status, &body));
        }
        Answered::Json { .. } => {}
    }
    crate::processes::report(app, hosted_report(sandbox_id, name, "running"));
    let app = app.clone();
    let window = window.clone();
    let sandbox_id = sandbox_id.to_string();
    let name = name.to_string();
    tauri::async_runtime::spawn(async move {
        follow_hosted(&app, &window, &sandbox_id, &name).await;
    });
    Ok(())
}

/// Whether the account's list says the sandbox has reported in. Pure.
fn reported_in(list: &Value, sandbox_id: &str) -> bool {
    let rows = list.as_array().or_else(|| list["sandboxes"].as_array());
    rows.into_iter().flatten().any(|row| {
        row["id"].as_str() == Some(sandbox_id)
            && !row["lastSeenAt"].is_null()
            && row.get("lastSeenAt").is_some()
    })
}

async fn follow_hosted(app: &AppHandle, window: &Webview, sandbox_id: &str, name: &str) {
    let started = std::time::Instant::now();
    while started.elapsed() < HOSTED_WAIT {
        tokio::time::sleep(HOSTED_POLL).await;
        if let Ok(Answered::Json { status, body }) =
            platform_get(app, window, "/rpc/sandbox/list").await
        {
            if (200..300).contains(&status) && reported_in(&body, sandbox_id) {
                let mut done = hosted_report(sandbox_id, name, "done");
                done.actions = vec!["open".into(), "dismiss".into()];
                crate::processes::report(app, done);
                return;
            }
        }
    }
    let mut late = hosted_report(sandbox_id, name, "failed");
    late.failure =
        Some("The machine hasn't reported in yet. The workspace's Home says how it stands.".into());
    late.actions = vec!["open".into(), "dismiss".into()];
    crate::processes::report(app, late);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_of_ours_is_offered_only_while_one_can_start_and_says_why_not() {
        assert_eq!(
            hosted_of(&json!({ "enabled": false, "remaining": 1 })),
            (false, None)
        );
        assert_eq!(
            hosted_of(&json!({ "enabled": true, "remaining": 1 })),
            (true, None)
        );
        for (offer, word) in [
            (
                json!({ "enabled": true, "remaining": 0, "needsGoogle": true }),
                "Google",
            ),
            (
                json!({ "enabled": true, "remaining": 1, "full": true }),
                "in use",
            ),
            (json!({ "enabled": true, "remaining": 0 }), "no machine"),
        ] {
            let (takeable, problem) = hosted_of(&offer);
            assert!(!takeable, "{offer}");
            assert!(problem.unwrap().contains(word), "{offer}");
        }
    }

    /// The folder a sandbox made here syncs is the one the workspace's own handover would have named.
    #[test]
    fn the_sync_folder_is_named_as_the_workspace_names_it() {
        assert_eq!(
            sync_folder("My Shop!", Some("sandbox-3fa9c1.sbx.intentic.dev")),
            "~/intentic/my-shop-3fa9c1"
        );
        assert_eq!(sync_folder("---", None), "~/intentic/sandbox");
        assert_eq!(
            sync_folder("shop", Some("custom.example.com")),
            "~/intentic/shop-custom"
        );
    }

    #[test]
    fn a_rows_token_is_read_off_the_list() {
        let list = json!([{ "id": "a", "token": "t-a" }, { "id": "b", "token": null }]);
        assert_eq!(token_of(&list, "a").as_deref(), Some("t-a"));
        assert_eq!(token_of(&list, "b"), None);
        assert_eq!(token_of(&list, "c"), None);
    }

    #[test]
    fn a_machine_is_in_once_its_row_has_been_seen() {
        let list = json!([{ "id": "a", "lastSeenAt": null }, { "id": "b", "lastSeenAt": "2026-10-26T10:00:00Z" }]);
        assert!(!reported_in(&list, "a"));
        assert!(reported_in(&list, "b"));
        assert!(!reported_in(&list, "c"));
        assert!(reported_in(
            &json!({ "sandboxes": [{ "id": "b", "lastSeenAt": "x" }] }),
            "b"
        ));
    }
}
