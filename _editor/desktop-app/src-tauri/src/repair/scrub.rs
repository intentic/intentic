//! Bound and scrub tool output before it reaches the model or the page.

const OUTPUT_MAX: usize = 12_000;

fn truncate_on_char_boundary(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… (truncated)", &text[..end])
}

fn replace_home(mut text: String, home: &str) -> String {
    if home.len() <= 3 {
        return text;
    }
    let variants = home_variants(home);
    for variant in variants {
        if variant.is_empty() {
            continue;
        }
        text = text.replace(&variant, "~");
        #[cfg(windows)]
        {
            text = text.replace(&variant.to_ascii_lowercase(), "~");
            text = text.replace(&variant.to_ascii_uppercase(), "~");
        }
    }
    text
}

fn home_variants(home: &str) -> Vec<String> {
    let mut out = vec![home.to_string()];
    let forward = home.replace('\\', "/");
    if forward != home {
        out.push(forward.clone());
    }
    let json_escaped = home.replace('\\', "\\\\");
    if json_escaped != home {
        out.push(json_escaped);
    }
    let json_forward = forward.replace('\\', "\\\\");
    if !out.iter().any(|v| v == &json_forward) {
        out.push(json_forward);
    }
    out
}

fn redact_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    let bytes = text.as_bytes();
    while index < bytes.len() {
        let rest = &text[index..];
        if let Some(stripped) = rest.strip_prefix("Bearer ") {
            out.push_str("Bearer [redacted]");
            index += "Bearer ".len() + token_len(stripped);
            continue;
        }
        if let Some(rest_after) = rest.strip_prefix("sk-") {
            out.push_str("sk-[redacted]");
            index += rest.len() - rest_after.len() + token_len(rest_after);
            continue;
        }
        if let Some(rest_after) = rest.strip_prefix("github_pat_") {
            out.push_str("[redacted]");
            index += rest.len() - rest_after.len() + token_len(rest_after);
            continue;
        }
        if let Some(rest_after) = rest.strip_prefix("ghp_") {
            out.push_str("[redacted]");
            index += rest.len() - rest_after.len() + token_len(rest_after);
            continue;
        }
        if let Some(rest_after) = rest.strip_prefix("gho_") {
            out.push_str("[redacted]");
            index += rest.len() - rest_after.len() + token_len(rest_after);
            continue;
        }
        if rest.starts_with("eyJ") {
            out.push_str("[redacted-jwt]");
            index += jwt_len(rest);
            continue;
        }
        if let Some(key) = secret_query_key(rest) {
            out.push_str(key);
            out.push_str("[redacted]");
            index += key.len() + secret_value_len(&rest[key.len()..]);
            continue;
        }
        if let Some(ch) = rest.chars().next() {
            out.push(ch);
            index += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn token_len(rest: &str) -> usize {
    rest.chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        .map(char::len_utf8)
        .sum()
}

fn jwt_len(rest: &str) -> usize {
    rest.chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '='))
        .map(char::len_utf8)
        .sum()
}

fn secret_query_key(rest: &str) -> Option<&'static str> {
    if rest.starts_with("token=") {
        Some("token=")
    } else if rest.starts_with("password=") {
        Some("password=")
    } else if rest.starts_with("secret=") {
        Some("secret=")
    } else {
        None
    }
}

fn secret_value_len(rest: &str) -> usize {
    rest.chars()
        .take_while(|ch| !matches!(ch, '&' | '\n' | '\r' | ' ' | '"'))
        .map(char::len_utf8)
        .sum()
}

/// Paths and bearer-like tokens must not reach the model.
pub fn scrub(text: &str, home: &str) -> String {
    let mut out = replace_home(text.to_string(), home);
    out = redact_tokens(&out);
    if out.len() > OUTPUT_MAX {
        out = truncate_on_char_boundary(&out, OUTPUT_MAX);
    }
    out
}

pub fn bound(text: String) -> String {
    if text.len() <= OUTPUT_MAX {
        return text;
    }
    truncate_on_char_boundary(&text, OUTPUT_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_is_scrubbed_and_long_output_is_cut() {
        let home = "/home/reader";
        let long = "x".repeat(OUTPUT_MAX + 50);
        let scrubbed = scrub(&format!("{home}/project\n{long}"), home);
        assert!(!scrubbed.contains(home));
        assert!(scrubbed.contains("~/project"));
        assert!(scrubbed.len() <= OUTPUT_MAX + 32);
    }

    #[test]
    fn truncate_does_not_split_a_multibyte_character() {
        let text = format!("{}…", "é".repeat(OUTPUT_MAX / 2));
        let cut = truncate_on_char_boundary(&text, OUTPUT_MAX);
        assert!(cut.is_char_boundary(cut.len()));
        assert!(cut.ends_with("(truncated)"));
    }

    #[test]
    fn json_escaped_home_is_scrubbed() {
        let home = r"C:\Users\reader";
        let escaped = r"C:\\Users\\reader\\project";
        let scrubbed = scrub(escaped, home);
        assert!(!scrubbed.contains("Users\\reader"));
        assert!(scrubbed.contains("~/project") || scrubbed.contains("~"));
    }

    #[test]
    fn bearer_tokens_are_redacted() {
        let scrubbed = scrub("Authorization: Bearer abc.def-ghi", "/home/x");
        assert!(scrubbed.contains("Bearer [redacted]"));
        assert!(!scrubbed.contains("abc.def"));
    }

    #[test]
    fn sk_and_gh_tokens_are_redacted() {
        let scrubbed = scrub("key=sk-live-abc ghp_abcdefghijklmnop", "/home/x");
        assert!(scrubbed.contains("sk-[redacted]"));
        assert!(scrubbed.contains("[redacted]"));
        assert!(!scrubbed.contains("sk-live"));
    }

    #[test]
    fn jwt_and_query_secrets_are_redacted() {
        let jwt = format!("eyJ{}.sig", "a".repeat(40));
        let scrubbed = scrub(
            &format!("{jwt} token=secret-value password=hide"),
            "/home/x",
        );
        assert!(scrubbed.contains("[redacted-jwt]"));
        assert!(scrubbed.contains("token=[redacted]"));
        assert!(scrubbed.contains("password=[redacted]"));
        assert!(!scrubbed.contains("secret-value"));
    }
}
