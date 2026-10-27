use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::{RecvStream, SendStream, presets},
};
use js_sys::Function;
use qrcode::{QrCode, render::svg};
use tokio::sync::Mutex;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

use crate::{ALPN, MAX_FRAME_BYTES};

type Writer = Rc<Mutex<SendStream>>;
type Peers = Rc<RefCell<BTreeMap<String, Writer>>>;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct Student {
    endpoint: Endpoint,
    _connection: iroh::endpoint::Connection,
    writer: Writer,
}

#[wasm_bindgen]
impl Student {
    #[wasm_bindgen(js_name = connect)]
    pub async fn connect(
        id: String,
        relay: String,
        key_hex: String,
        on_message: Function,
        on_disconnect: Function,
    ) -> Result<Student, JsError> {
        let id: EndpointId = id.parse().map_err(js_error)?;
        let relay: RelayUrl = without_trailing_relay_dot(&relay).parse().map_err(js_error)?;
        let address = EndpointAddr::new(id).with_relay_url(relay);
        let endpoint = Endpoint::builder(presets::N0)
            .relay_mode(browser_relay_mode()?)
            .secret_key(secret_from_hex(&key_hex)?)
            .bind()
            .await
            .map_err(js_error)?;
        let connection = endpoint.connect(address, ALPN).await.map_err(js_error)?;
        let (mut send, receive) = connection.open_bi().await.map_err(js_error)?;
        // A stream is not visible to the remote peer until it carries data.
        // An empty frame announces this student's presence without a chat message.
        send.write_all(&0u32.to_be_bytes()).await.map_err(js_error)?;
        let writer = Rc::new(Mutex::new(send));
        spawn_local(async move {
            read_messages(receive, |text| {
                let _ = on_message.call1(&JsValue::NULL, &JsValue::from(text));
            })
            .await;
            let _ = on_disconnect.call0(&JsValue::NULL);
        });
        Ok(Student { endpoint, _connection: connection, writer })
    }

    pub async fn send(&self, text: String) -> Result<(), JsError> {
        let text = checked_frame(&text)?;
        write_message(&self.writer, &text).await.map_err(js_error)
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

#[wasm_bindgen]
pub struct Teacher {
    endpoint: Endpoint,
    peers: Peers,
}

#[wasm_bindgen]
impl Teacher {
    #[wasm_bindgen(js_name = host)]
    pub async fn host(
        key_hex: String,
        on_message: Function,
        on_peer: Function,
    ) -> Result<Teacher, JsError> {
        let endpoint = Endpoint::builder(presets::N0)
            .relay_mode(browser_relay_mode()?)
            .secret_key(secret_from_hex(&key_hex)?)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(js_error)?;
        endpoint.online().await;
        let peers: Peers = Rc::new(RefCell::new(BTreeMap::new()));
        let listener = endpoint.clone();
        let active_peers = peers.clone();
        spawn_local(async move {
            while let Some(connecting) = listener.accept().await {
                let connection = match connecting.await {
                    Ok(connection) => connection,
                    Err(_) => continue,
                };
                let peer = connection.remote_id().to_string();
                let peers = active_peers.clone();
                let message_callback = on_message.clone();
                let peer_callback = on_peer.clone();
                spawn_local(async move {
                    let (send, receive) = match connection.accept_bi().await {
                        Ok(streams) => streams,
                        Err(_) => return,
                    };
                    let writer = Rc::new(Mutex::new(send));
                    peers.borrow_mut().insert(peer.clone(), writer.clone());
                    let _ = peer_callback.call2(
                        &JsValue::NULL,
                        &JsValue::from(peer.clone()),
                        &JsValue::TRUE,
                    );
                    read_messages(receive, |text| {
                        let _ = message_callback.call2(
                            &JsValue::NULL,
                            &JsValue::from(peer.clone()),
                            &JsValue::from(text),
                        );
                    })
                    .await;
                    let is_current = peers.borrow().get(&peer)
                        .is_some_and(|current| Rc::ptr_eq(current, &writer));
                    if is_current {
                        peers.borrow_mut().remove(&peer);
                        let _ = peer_callback.call2(
                            &JsValue::NULL,
                            &JsValue::from(peer),
                            &JsValue::FALSE,
                        );
                    }
                });
            }
        });
        Ok(Teacher { endpoint, peers })
    }

    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    pub fn relay_url(&self) -> Result<String, JsError> {
        self.endpoint.addr().relay_urls().next().map(ToString::to_string)
            .ok_or_else(|| JsError::new("No Iroh relay address is available"))
    }

    pub async fn send(&self, peer: String, text: String) -> Result<(), JsError> {
        let text = checked_frame(&text)?;
        let writer = self.peers.borrow().get(&peer).cloned()
            .ok_or_else(|| JsError::new("Student is disconnected"))?;
        write_message(&writer, &text).await.map_err(js_error)
    }

    pub async fn stop(&self) {
        self.peers.borrow_mut().clear();
        self.endpoint.close().await;
    }
}

#[wasm_bindgen]
pub fn qr_svg(url: String) -> Result<String, JsError> {
    let code = QrCode::new(url.as_bytes()).map_err(js_error)?;
    Ok(code.render::<svg::Color>().min_dimensions(320, 320).build())
}

async fn read_messages(mut receive: RecvStream, mut on_message: impl FnMut(String)) {
    loop {
        let mut length = [0u8; 4];
        if receive.read_exact(&mut length).await.is_err() {
            break;
        }
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 {
            continue;
        }
        if length > MAX_FRAME_BYTES {
            break;
        }
        let mut bytes = vec![0u8; length];
        if receive.read_exact(&mut bytes).await.is_err() {
            break;
        }
        match String::from_utf8(bytes) {
            Ok(text) => on_message(text),
            Err(_) => break,
        }
    }
}

async fn write_message(writer: &Writer, text: &str) -> Result<(), String> {
    let mut send = writer.lock().await;
    let length = (text.len() as u32).to_be_bytes();
    send.write_all(&length).await.map_err(|error| error.to_string())?;
    send.write_all(text.as_bytes()).await.map_err(|error| error.to_string())?;
    Ok(())
}

fn secret_from_hex(key_hex: &str) -> Result<SecretKey, JsError> {
    let bytes = hex::decode(key_hex).map_err(js_error)?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| JsError::new("Invalid browser key"))?;
    Ok(SecretKey::from_bytes(&bytes))
}

fn browser_relay_mode() -> Result<RelayMode, JsError> {
    // Iroh 1.3's production hostnames end in a dot. Safari on iOS rejects
    // HTTPS/WebSocket connections to those relay URLs.
    let urls: Vec<RelayUrl> = iroh::defaults::prod::default_relay_map().urls();
    let urls: Vec<String> = urls.iter()
        .map(|url| without_trailing_relay_dot(&url.to_string()))
        .collect();
    let map = RelayMap::try_from_iter(urls.iter().map(String::as_str)).map_err(js_error)?;
    Ok(RelayMode::Custom(map))
}

fn without_trailing_relay_dot(url: &str) -> String {
    url.replace(".iroh.link./", ".iroh.link/")
}

fn checked_frame(text: &str) -> Result<String, JsError> {
    if text.is_empty() || text.len() > MAX_FRAME_BYTES {
        return Err(JsError::new("Chat frame must be 1–32768 bytes."));
    }
    Ok(text.to_owned())
}

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}
