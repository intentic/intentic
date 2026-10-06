//! A PowerShell script as both binaries hand it to `powershell.exe`: `-EncodedCommand`, never a quoted command line.
//!
//! A script passed as `-Command <text>` goes through Windows' command-line quoting and then PowerShell's own, and a
//! quote or a newline in it does not survive both. The encoded form is opaque to either.

/// base64, standard alphabet, no wrapping. Hand-rolled rather than pulled in: `ic` is downloaded on every run, and 20
/// lines beats a dependency for the one thing it is needed for.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A PowerShell script as the argument `-EncodedCommand` wants: UTF-16LE, base64. Pure, so the encoding is tested on
/// the runner that cross-builds both binaries and never runs them.
pub fn encoded(script: &str) -> String {
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64(&utf16)
}

/// Everything after `powershell.exe` for one non-interactive run of `script`: no profile, no execution policy in the
/// way (scoped to this process, as the setup one-liner's own bypass is), and the script encoded.
pub fn args(script: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    args.push(encoded(script));
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_reference_vectors() {
        // RFC 4648's own test vectors — padding is where hand-rolled encoders go wrong.
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // High bytes must not sign-extend into the wrong sextet.
        assert_eq!(base64(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64(&[0x00, 0x00, 0x00]), "AAAA");
    }

    #[test]
    fn encoded_commands_are_utf16le_which_is_what_powershell_decodes() {
        // `echo hi` as PowerShell itself produces it — the one assertion that proves the byte order.
        assert_eq!(encoded("hi"), "aABpAA==");
        // Every ASCII character becomes two bytes, so the base64 is 4 chars per 3 BYTES, not per character.
        assert_eq!(encoded("abc").len(), 8);
    }

    #[test]
    fn a_run_is_non_interactive_and_ends_with_the_encoded_script() {
        assert_eq!(
            args("hi"),
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                "aABpAA=="
            ]
        );
    }
}
