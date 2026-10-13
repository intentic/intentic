use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use super::page::{self, State};
use super::{claim, code, Claim, Shared};

/* THE PAIRING PAGE'S SERVER: three routes over plain HTTP/1.1 on the local network, for the few minutes before the
machine has a sandbox, written on std::net because a web framework would be most of this binary's size for a form.
`GET /` draws the page, `POST /pair` takes `code=…` as a browser's form sends it, `GET /status` answers JSON. Every
connection gets a deadline and is closed after one answer, and only a few are served at once.

The page takes the code that decides whose sandbox this machine becomes, so it answers only to the names the machine
has on the network (an IP address, `intentic.local`, its own host name): a page elsewhere that points a name of its own
at this address (DNS rebinding) is turned away, and so is a form posted from another site's page. */

/// How long one request may take to arrive, and its answer to leave.
const IO_LIMIT: Duration = Duration::from_secs(5);
/// The most of a request's head that is read.
const HEAD_MAX: usize = 16 * 1024;
/// The most of a body that is read: a form with one field.
const BODY_MAX: usize = 8 * 1024;
/// Connections served at once; one past it is closed unanswered.
const CONNECTIONS_MAX: usize = 16;

/// A request as the routes read it.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub content_length: usize,
    pub body: String,
}

/// The request line and the headers the routes read, from a request's head (everything before the blank line). Pure.
pub fn parse_head(head: &str) -> Option<Request> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?;
    first
        .next()
        .filter(|version| version.starts_with("HTTP/1."))?;
    let path = target.split('?').next().unwrap_or_default().to_string();
    let mut request = Request {
        method,
        path,
        ..Request::default()
    };
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "host" => request.host = Some(value.to_string()),
            "origin" => request.origin = Some(value.to_string()),
            "content-length" => request.content_length = value.parse().ok()?,
            _ => {}
        }
    }
    Some(request)
}

/// One field of an `application/x-www-form-urlencoded` body, decoded. Pure.
pub fn form_value(body: &str, key: &str) -> Option<String> {
    body.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (decode(name) == key).then(|| decode(value))
    })
}

/// `+` as a space and `%XX` as its byte; a `%` that is not followed by two hex digits is kept as it is. Pure.
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => out.push(b' '),
            b'%' if at + 2 < bytes.len()
                && hex(bytes[at + 1]).is_some()
                && hex(bytes[at + 2]).is_some() =>
            {
                out.push(hex(bytes[at + 1]).unwrap_or(0) * 16 + hex(bytes[at + 2]).unwrap_or(0));
                at += 2;
            }
            byte => out.push(byte),
        }
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

/// Whether a request's `Host` names this machine: an IPv4 address, `localhost`, `intentic.local`, or the machine's own
/// host name (with or without `.local`), each with or without a port. Pure.
pub fn host_allowed(host: Option<&str>, hostname: &str) -> bool {
    let Some(host) = host else {
        return false;
    };
    let name = match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => host,
    };
    let name = name.to_ascii_lowercase();
    let own = hostname.trim().to_ascii_lowercase();
    name.parse::<std::net::Ipv4Addr>().is_ok()
        || name == "localhost"
        || name == "intentic.local"
        || (!own.is_empty() && (name == own || name == format!("{own}.local")))
}

/// Whether a form post came from this page: a browser names the page it posted from in `Origin`, and one from another
/// site names that site. No `Origin` at all is a client that is not a browser, which no other page can drive. Pure.
pub fn same_origin(request: &Request) -> bool {
    match (&request.origin, &request.host) {
        (None, _) => true,
        (Some(origin), Some(host)) => origin.eq_ignore_ascii_case(&format!("http://{host}")),
        (Some(_), None) => false,
    }
}

/// An HTTP/1.1 answer that closes the connection.
pub fn response(status: &str, content_type: &str, extra: &[(&str, &str)], body: &str) -> Vec<u8> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\
Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n\
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'\r\n",
        body.len()
    );
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

const HTML: &str = "text/html; charset=utf-8";
const TEXT: &str = "text/plain; charset=utf-8";

/// The answer to one request. Only a `POST /pair` with a code changes anything: it claims the one attempt and hands
/// the code to whoever runs it.
pub fn route(
    request: &Request,
    hostname: &str,
    shared: &Shared,
    codes: &Sender<String>,
) -> Vec<u8> {
    if !host_allowed(request.host.as_deref(), hostname) {
        return response(
            "421 Misdirected Request",
            TEXT,
            &[],
            "Open this page by the machine's address.\n",
        );
    }
    let state = || super::lock(shared).clone();
    match (request.method.as_str(), request.path.as_str()) {
        ("GET" | "HEAD", "/") => response("200 OK", HTML, &[], &page::page(&state(), None)),
        ("GET" | "HEAD", "/status") => response(
            "200 OK",
            "application/json",
            &[],
            &page::status_json(&state()).to_string(),
        ),
        ("POST", "/pair") if !same_origin(request) => response(
            "403 Forbidden",
            TEXT,
            &[],
            "A setup code is taken only from this machine's own page.\n",
        ),
        ("POST", "/pair") => post_pair(request, shared, codes),
        (_, "/" | "/status" | "/pair") => {
            response("405 Method Not Allowed", TEXT, &[], "Not here.\n")
        }
        _ => response("404 Not Found", TEXT, &[], "Not here.\n"),
    }
}

fn post_pair(request: &Request, shared: &Shared, codes: &Sender<String>) -> Vec<u8> {
    let pasted = form_value(&request.body, "code").unwrap_or_default();
    let Some(code) = code::setup_code(&pasted) else {
        let state: State = super::lock(shared).clone();
        return response(
            "400 Bad Request",
            HTML,
            &[],
            &page::page(
                &state,
                Some("No setup code was found in that. Paste the code (letters and digits) or the whole setup command."),
            ),
        );
    };
    match claim(shared, &code, codes, "this page") {
        Claim::Accepted | Claim::Done => {
            response("303 See Other", TEXT, &[("Location", "/")], "Pairing.\n")
        }
        Claim::Busy => {
            let state: State = super::lock(shared).clone();
            response(
                "409 Conflict",
                HTML,
                &[],
                &page::page(
                    &state,
                    Some("A code is being tried already; wait for it to finish."),
                ),
            )
        }
    }
}

/// Serve the page until the process ends, a thread per connection, at most [`CONNECTIONS_MAX`] at once.
pub fn serve(listener: TcpListener, hostname: String, shared: Shared, codes: Sender<String>) {
    let open = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming().flatten() {
        if open.fetch_add(1, Ordering::SeqCst) >= CONNECTIONS_MAX {
            open.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let (open, hostname, shared, codes) = (
            open.clone(),
            hostname.clone(),
            shared.clone(),
            codes.clone(),
        );
        std::thread::spawn(move || {
            answer(stream, &hostname, &shared, &codes);
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

/// Read one request off a connection, answer it, close it. A request that is too big, too slow or not HTTP gets 400.
fn answer(mut stream: TcpStream, hostname: &str, shared: &Shared, codes: &Sender<String>) {
    let _ = stream.set_read_timeout(Some(IO_LIMIT));
    let _ = stream.set_write_timeout(Some(IO_LIMIT));
    let reply = match read_request(&mut stream) {
        Some(request) => {
            let reply = route(&request, hostname, shared, codes);
            if request.method == "HEAD" {
                head_only(reply)
            } else {
                reply
            }
        }
        None => response(
            "400 Bad Request",
            TEXT,
            &[],
            "That was not a request this page understands.\n",
        ),
    };
    let _ = stream.write_all(&reply);
    let _ = stream.flush();
}

/// A HEAD answer: the GET's head without its body.
fn head_only(mut reply: Vec<u8>) -> Vec<u8> {
    if let Some(at) = reply.windows(4).position(|window| window == b"\r\n\r\n") {
        reply.truncate(at + 4);
    }
    reply
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    let end = loop {
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        if buffer.len() > HEAD_MAX {
            return None;
        }
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let mut request = parse_head(std::str::from_utf8(&buffer[..end]).ok()?)?;
    if request.content_length > BODY_MAX {
        return None;
    }
    let mut body = buffer[end + 4..].to_vec();
    while body.len() < request.content_length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(request.content_length);
    request.body = String::from_utf8_lossy(&body).into_owned();
    Some(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::os::pair::page::Phase;
    use std::sync::mpsc;
    use std::sync::Mutex;

    fn shared() -> Shared {
        Arc::new(Mutex::new(State::waiting()))
    }

    fn post(body: &str) -> Request {
        Request {
            method: "POST".to_string(),
            path: "/pair".to_string(),
            host: Some("intentic.local".to_string()),
            origin: Some("http://intentic.local".to_string()),
            content_length: body.len(),
            body: body.to_string(),
        }
    }

    fn status_of(reply: &[u8]) -> String {
        String::from_utf8_lossy(reply)
            .lines()
            .next()
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn a_browsers_request_head_is_read_for_what_the_routes_need() {
        let request = parse_head(
            "POST /pair?x=1 HTTP/1.1\r\nHost: 192.168.1.20\r\nOrigin: http://192.168.1.20\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 16",
        )
        .expect("parsed");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/pair");
        assert_eq!(request.host.as_deref(), Some("192.168.1.20"));
        assert_eq!(request.origin.as_deref(), Some("http://192.168.1.20"));
        assert_eq!(request.content_length, 16);
        assert!(parse_head("GET /").is_none());
        assert!(parse_head("GET / SPDY/3").is_none());
        assert!(parse_head("POST / HTTP/1.1\r\nContent-Length: lots").is_none());
    }

    #[test]
    fn a_form_field_is_decoded_as_a_browser_encoded_it() {
        let body = "x=1&code=curl+-fsSL+https%3A%2F%2Fintentic.dev%2Fsetup%2Fvphf3wkQ7xK+%7C+sh&y";
        assert_eq!(
            form_value(body, "code").as_deref(),
            Some("curl -fsSL https://intentic.dev/setup/vphf3wkQ7xK | sh")
        );
        assert_eq!(form_value("code=", "code").as_deref(), Some(""));
        assert_eq!(form_value("other=1", "code"), None);
        assert_eq!(
            form_value("code=100%25+%zz%", "code").as_deref(),
            Some("100% %zz%")
        );
    }

    #[test]
    fn only_the_machines_own_names_are_answered() {
        for host in [
            "192.168.1.20",
            "192.168.1.20:8080",
            "intentic.local",
            "INTENTIC.local:80",
            "localhost",
            "box",
            "box.local",
        ] {
            assert!(host_allowed(Some(host), "box"), "{host}");
        }
        for host in [
            "evil.example",
            "intentic.local.evil.example",
            "box.example",
            "",
        ] {
            assert!(!host_allowed(Some(host), "box"), "{host}");
        }
        assert!(!host_allowed(None, "box"));
        assert!(!host_allowed(Some("evil.example"), ""));
    }

    #[test]
    fn a_post_from_another_sites_page_is_refused() {
        let (codes, received) = mpsc::channel();
        let shared = shared();
        let mut forged = post("code=vphf3wkQ7xK");
        forged.origin = Some("https://evil.example".to_string());
        assert!(status_of(&route(&forged, "box", &shared, &codes)).starts_with("HTTP/1.1 403"));
        assert!(received.try_recv().is_err());
        assert_eq!(super::super::lock(&shared).phase, Phase::Waiting);
        // A client with no Origin (curl on the network) is no other site's page.
        let mut plain = post("code=vphf3wkQ7xK");
        plain.origin = None;
        assert!(status_of(&route(&plain, "box", &shared, &codes)).starts_with("HTTP/1.1 303"));
    }

    #[test]
    fn a_code_is_claimed_once_and_the_rest_wait() {
        let (codes, received) = mpsc::channel();
        let shared = shared();
        let reply = route(
            &post("code=ic+sandbox+connect+vphf3wkQ7xK"),
            "box",
            &shared,
            &codes,
        );
        assert!(status_of(&reply).starts_with("HTTP/1.1 303"));
        assert!(String::from_utf8_lossy(&reply).contains("Location: /\r\n"));
        assert_eq!(received.try_recv().as_deref(), Ok("vphf3wkQ7xK"));
        assert_eq!(super::super::lock(&shared).phase, Phase::Pairing);
        let again = route(&post("code=OtherCode123"), "box", &shared, &codes);
        assert!(status_of(&again).starts_with("HTTP/1.1 409"));
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn a_paste_with_no_code_is_told_so_and_claims_nothing() {
        let (codes, received) = mpsc::channel();
        let shared = shared();
        let reply = route(&post("code=hello"), "box", &shared, &codes);
        assert!(status_of(&reply).starts_with("HTTP/1.1 400"));
        assert!(String::from_utf8_lossy(&reply).contains("No setup code was found"));
        assert!(received.try_recv().is_err());
        assert_eq!(super::super::lock(&shared).phase, Phase::Waiting);
    }

    #[test]
    fn the_page_and_status_answer_and_nothing_else_does() {
        let (codes, _received) = mpsc::channel();
        let shared = shared();
        let get = |path: &str, host: &str| {
            route(
                &Request {
                    method: "GET".to_string(),
                    path: path.to_string(),
                    host: Some(host.to_string()),
                    ..Request::default()
                },
                "box",
                &shared,
                &codes,
            )
        };
        let page = get("/", "intentic.local");
        assert!(status_of(&page).starts_with("HTTP/1.1 200"));
        assert!(String::from_utf8_lossy(&page).contains("<form"));
        let status = String::from_utf8_lossy(&get("/status", "10.0.0.5")).into_owned();
        assert!(status.contains("application/json"));
        assert!(status.ends_with(&page::status_json(&State::waiting()).to_string()));
        assert!(status_of(&get("/pair", "intentic.local")).starts_with("HTTP/1.1 405"));
        assert!(status_of(&get("/admin", "intentic.local")).starts_with("HTTP/1.1 404"));
        assert!(status_of(&get("/", "rebound.example")).starts_with("HTTP/1.1 421"));
        let head = head_only(get("/", "intentic.local"));
        assert!(head.ends_with(b"\r\n\r\n"));
    }

    #[test]
    fn a_whole_request_is_read_off_a_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let (codes, received) = mpsc::channel();
        let shared = shared();
        let served = shared.clone();
        std::thread::spawn(move || serve(listener, "box".to_string(), served, codes));
        let mut client = TcpStream::connect(address).expect("connect");
        let body = "code=vphf3wkQ7xK";
        write!(
            client,
            "POST /pair HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .expect("sent");
        let mut reply = String::new();
        client.read_to_string(&mut reply).expect("answered");
        assert!(reply.starts_with("HTTP/1.1 303"), "{reply}");
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).as_deref(),
            Ok("vphf3wkQ7xK")
        );
    }
}
