use intentic_desktop_core::types::SetupMode;
use serde::{Deserialize, Serialize};

/// The setup request handed to the app — by the SPA's "Run on this computer" button (an
/// `intentic://` navigation the workspace window intercepts) or an OS deep link from an external
/// browser. Everything the native pipeline needs beyond what `/setup/claim` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupArgs {
    pub code: String,
    pub mode: SetupMode,
    pub name: Option<String>,
    pub cf_token: Option<String>,
    pub sync_dir: Option<String>,
    pub platform_url: Option<String>,
}

/// Parse an `intentic://setup?…` link. Unknown hosts/actions and missing codes return None so a
/// malformed link can never start a setup.
pub fn parse_setup_link(url: &str) -> Option<SetupArgs> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "intentic" || parsed.host_str() != Some("setup") {
        return None;
    }
    let mut code = None;
    let mut mode = None;
    let mut name = None;
    let mut cf_token = None;
    let mut sync_dir = None;
    let mut platform_url = None;
    for (key, value) in parsed.query_pairs() {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.as_ref() {
            "code" => code = Some(value.to_string()),
            "mode" => {
                mode = match value {
                    "intentic" => Some(SetupMode::Intentic),
                    "own" => Some(SetupMode::Own),
                    "local" => Some(SetupMode::Local),
                    _ => return None,
                }
            }
            "name" => name = Some(value.to_string()),
            "cfToken" => cf_token = Some(value.to_string()),
            "syncDir" => sync_dir = Some(value.to_string()),
            "platform" => platform_url = Some(value.to_string()),
            _ => {}
        }
    }
    Some(SetupArgs {
        code: code?,
        mode: mode?,
        name,
        cf_token,
        sync_dir,
        platform_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_setup_link() {
        let args = parse_setup_link(
            "intentic://setup?code=abc123&mode=intentic&name=My%20Sandbox&syncDir=%7E%2Fintentic%2Fwork&platform=https%3A%2F%2Fapp.intentic.dev",
        )
        .unwrap();
        assert_eq!(args.code, "abc123");
        assert_eq!(args.mode, SetupMode::Intentic);
        assert_eq!(args.name.as_deref(), Some("My Sandbox"));
        assert_eq!(args.sync_dir.as_deref(), Some("~/intentic/work"));
        assert_eq!(
            args.platform_url.as_deref(),
            Some("https://app.intentic.dev")
        );
        assert_eq!(args.cf_token, None);
    }

    #[test]
    fn rejects_foreign_or_incomplete_links() {
        assert_eq!(
            parse_setup_link("https://app.intentic.dev/setup?code=x&mode=intentic"),
            None
        );
        assert_eq!(
            parse_setup_link("intentic://other?code=x&mode=intentic"),
            None
        );
        assert_eq!(parse_setup_link("intentic://setup?mode=intentic"), None);
        assert_eq!(parse_setup_link("intentic://setup?code=x&mode=bogus"), None);
    }
}
