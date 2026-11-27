//! The one client the edge asks the platform with, over HTTPS on the internet or plain HTTP on a private network: bare
//! for the questions that send nothing, and with a body for the request wake's ask (wakes.rs).

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{Empty, Full};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

pub type PlatformClient = Client<HttpsConnector<HttpConnector>, Empty<Bytes>>;
pub type PlatformPoster = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

fn connector() -> HttpsConnector<HttpConnector> {
    hyper_rustls::HttpsConnectorBuilder::new()
        .with_provider_and_webpki_roots(Arc::new(rustls::crypto::ring::default_provider()))
        .expect("ring supports the default protocol versions")
        .https_or_http()
        .enable_http1()
        .build()
}

pub fn client() -> PlatformClient {
    Client::builder(TokioExecutor::new()).build(connector())
}

pub fn poster() -> PlatformPoster {
    Client::builder(TokioExecutor::new()).build(connector())
}
