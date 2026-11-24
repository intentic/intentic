/* THE SETUP CODE, OUT OF WHATEVER WAS PASTED. The setup page hands a person a whole command, not a code, and on a
console with no copy and paste they will type what they see; on the LAN page they will paste the command they copied.
Either way only the code matters. The platform mints it as 11 base62 characters (_platform/api mint-sandbox.ts), and
the one-liner table takes `[A-Za-z0-9]{6,64}` (@intentic/constants SETUP_CODE_PATTERN), so that is what is looked for,
in every shape the setup page and the docs give it in:

- the code alone, quoted or not;
- the one-liner, `curl -fsSL https://intentic.dev/setup/<code>[/<folder>] | sh` or `irm …/setup/<code> | iex`;
- the environment form, `… | env … sh -s -- '<code>'` and `$env:SETUP_CODE='<code>'; irm … | iex`;
- a checkout's script by path, `sh …/connect.sh '<code>'` and `& ./…/connect.ps1 -SetupCode '<code>'`;
- `ic sandbox connect <code>` itself. */

/// The most of a paste that is read: a setup command is a line, not a document.
const PASTE_MAX: usize = 4096;

/// Whether `word` has a setup code's shape. Pure.
fn is_code(word: &str) -> bool {
    (6..=64).contains(&word.len()) && word.chars().all(|c| c.is_ascii_alphanumeric())
}

/// The setup code in a paste, or None when there is none to be found. Pure.
pub fn setup_code(pasted: &str) -> Option<String> {
    let mut end = pasted.len().min(PASTE_MAX);
    while !pasted.is_char_boundary(end) {
        end -= 1;
    }
    let text = pasted[..end].trim();
    let bare = unquote(text);
    if is_code(bare) {
        return Some(bare.to_string());
    }
    after(text, "/setup/", false)
        .or_else(|| after(text, "SETUP_CODE=", false))
        .or_else(|| after(text, "-SetupCode", true))
        .or_else(|| positional(text))
}

/// A word without the quotes a shell would take off it.
fn unquote(word: &str) -> &str {
    word.trim_matches(|c| matches!(c, '\'' | '"' | '‘' | '’' | '“' | '”'))
}

/// The code right after `marker` (case-insensitive when `any_case`), past any quotes, spaces or a `:` between them.
fn after(text: &str, marker: &str, any_case: bool) -> Option<String> {
    let at = if any_case {
        text.to_ascii_lowercase().find(&marker.to_ascii_lowercase())
    } else {
        text.find(marker)
    }?;
    let rest = text[at + marker.len()..].trim_start_matches(|c: char| {
        c.is_whitespace() || matches!(c, ':' | '\'' | '"' | '‘' | '’' | '“' | '”')
    });
    let word: String = rest
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    is_code(&word).then_some(word)
}

/// The first word that is not a flag after `--`, after a `connect.sh`, or after `sandbox connect`.
fn positional(text: &str) -> Option<String> {
    let words: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '|'))
        .filter(|word| !word.is_empty())
        .collect();
    words.iter().enumerate().find_map(|(at, word)| {
        let opens = *word == "--"
            || unquote(word).ends_with("connect.sh")
            || (*word == "connect" && at > 0 && words[at - 1] == "sandbox");
        if !opens {
            return None;
        }
        words[at + 1..]
            .iter()
            .map(|word| unquote(word))
            .find(|word| !word.starts_with('-'))
            .filter(|word| is_code(word))
            .map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "vphf3wkQ7xK";

    #[test]
    fn the_code_alone_is_the_code() {
        for pasted in [
            "vphf3wkQ7xK",
            "  vphf3wkQ7xK\n",
            "'vphf3wkQ7xK'",
            "\"vphf3wkQ7xK\"",
        ] {
            assert_eq!(setup_code(pasted).as_deref(), Some(CODE), "{pasted:?}");
        }
    }

    #[test]
    fn every_command_the_setup_page_gives_carries_it_out() {
        // The shapes _editor/web's installCommand.test.ts pins, as a person copies them.
        for pasted in [
            "curl -fsSL https://intentic.dev/setup/vphf3wkQ7xK | sh",
            "curl -fsSL https://intentic.dev/setup/vphf3wkQ7xK/my-project-ab12 | sh",
            "irm https://intentic.dev/setup/vphf3wkQ7xK | iex",
            "https://intentic.dev/setup/vphf3wkQ7xK",
            "curl -fsSL https://intentic.dev/connect | env SYNC_DIR='~/Projects/mine' sh -s -- 'vphf3wkQ7xK'",
            "curl -fsSL https://intentic.dev/connect | env CF_TOKEN=cf-token PLATFORM_URL=https://localhost:6480 INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth' sh -s -- vphf3wkQ7xK",
            "$env:SETUP_CODE='vphf3wkQ7xK'; irm https://intentic.dev/connect.ps1 | iex",
            "$env:WEB_ORIGIN='https://app.example.dev'; $env:SETUP_CODE='vphf3wkQ7xK'; irm https://intentic.dev/connect.ps1 | iex",
            "env SYNC_DIR='~/intentic/proj' sh _site/site/public/scripts/connect.sh 'vphf3wkQ7xK'",
            "& ./_site/site/public/scripts/connect.ps1 -SetupCode 'vphf3wkQ7xK' -SyncDir '~/intentic/proj'",
            "SETUP_CODE=vphf3wkQ7xK ic sandbox connect",
            "ic sandbox connect vphf3wkQ7xK",
            "sudo ic sandbox connect -y vphf3wkQ7xK",
            "ic sandbox connect -y -- vphf3wkQ7xK",
        ] {
            assert_eq!(setup_code(pasted).as_deref(), Some(CODE), "{pasted:?}");
        }
    }

    #[test]
    fn what_carries_no_code_is_none() {
        for pasted in [
            "",
            "   ",
            "hello",
            "vphf3wk-Q7xK",
            "curl -fsSL https://intentic.dev/connect | sh",
            "https://intentic.dev/setup/",
            "https://intentic.dev/setup/abc",
            "ic sandbox connect",
            "ic sandbox connect -y",
            "sh -s -- 'a b'",
            "$env:SETUP_CODE=''; irm https://intentic.dev/connect.ps1 | iex",
        ] {
            assert_eq!(setup_code(pasted), None, "{pasted:?}");
        }
        assert_eq!(setup_code(&"a".repeat(65)), None);
    }

    #[test]
    fn a_huge_paste_is_read_only_as_far_as_a_command_goes() {
        let pasted = format!("{}{}", " ".repeat(PASTE_MAX), CODE);
        assert_eq!(setup_code(&pasted), None);
        let pasted = format!("ic sandbox connect {CODE} {}", "x".repeat(10_000));
        assert_eq!(setup_code(&pasted).as_deref(), Some(CODE));
    }
}
