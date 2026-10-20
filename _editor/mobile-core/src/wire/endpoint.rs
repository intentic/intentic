//! Where each call goes: a method and a path, declared beside the types it carries so `net` never spells a route.
//!
//! The daemon and the platform both serve their oRPC contracts through oRPC's OpenAPI handler, so a procedure is plain
//! HTTP: `{name}` segments of its path come from the input's fields of that name, a GET's other fields ride the query
//! string (as text, which the contract coerces back to numbers), and a POST's other fields are the JSON body. The
//! answer is the output as JSON, with no envelope. The daemon serves at its root, the platform under `/rpc`.

/// The two methods the app calls with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

/// One route: its method, and its path from the server's base address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Endpoint {
    pub method: Method,
    pub path: &'static str,
}

impl Endpoint {
    pub const fn get(path: &'static str) -> Endpoint {
        Endpoint {
            method: Method::Get,
            path,
        }
    }

    pub const fn post(path: &'static str) -> Endpoint {
        Endpoint {
            method: Method::Post,
            path,
        }
    }

    /// The path with each `{name}` filled from `params`, each value encoded as one path segment. A name with no value
    /// is left as written, which the server answers with a 404 rather than a call on the wrong conversation.
    pub fn path_with(&self, params: &[(&str, &str)]) -> String {
        let mut path = self.path.to_owned();
        for (name, value) in params {
            path = path.replace(&format!("{{{name}}}"), &encode(value));
        }
        path
    }
}

/// A query string from the pairs that have a value, `?a=1&b=2`, or nothing when none has.
pub fn query(pairs: &[(&str, Option<String>)]) -> String {
    let joined: Vec<String> = pairs
        .iter()
        .filter_map(|(name, value)| {
            value
                .as_ref()
                .map(|value| format!("{}={}", encode(name), encode(value)))
        })
        .collect();
    if joined.is_empty() {
        String::new()
    } else {
        format!("?{}", joined.join("&"))
    }
}

/// Percent-encodes everything but RFC 3986's unreserved characters, which is right for a path segment and for a query
/// value alike.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_a_path_and_a_query() {
        let route = Endpoint::get("/agents/{id}/transcript");
        assert_eq!(
            route.path_with(&[("id", "cnv 1/2")]),
            "/agents/cnv%201%2F2/transcript"
        );
        assert_eq!(
            query(&[("before", Some("40".into())), ("turns", None)]),
            "?before=40"
        );
        assert_eq!(query(&[("turns", None)]), "");
    }
}
