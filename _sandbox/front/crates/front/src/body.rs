//! The one body type every response and forwarded request is carried in, whatever produced it.

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full, combinators::UnsyncBoxBody};
use hyper::body::Incoming;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub type Body = UnsyncBoxBody<Bytes, BoxError>;

pub fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

pub fn empty() -> Body {
    Empty::new().map_err(|never| match never {}).boxed_unsync()
}

pub fn incoming(body: Incoming) -> Body {
    body.map_err(Into::into).boxed_unsync()
}
