# Please Ask

A teacher-operated classroom chat built with Rust, WebAssembly, and [Iroh](https://www.iroh.computer/). Students scan a QR code to open a chatbot-style conversation. The teacher sees one ongoing message thread per student and can send messages while that student is connected. No AI service is involved.

Both sides run in the browser. The teacher browser owns one Iroh identity and accepts student connections over an Iroh relay. Its secret key is generated with the browser's cryptographic random source and saved in that browser's `localStorage`, so reopening the teacher page on the same browser and origin keeps the identity. Each student browser also saves an identity for that teacher, allowing its conversation to resume after reconnecting. The join QR code is refreshed when the teacher starts and includes the current relay URL.

## Build

You need Rust with the `wasm32-unknown-unknown` target, LLVM `clang` and `wasm-ld` with WebAssembly support for the `ring` dependency, and `wasm-bindgen-cli` version `0.2.121`.

```sh
cargo install wasm-bindgen-cli --version 0.2.121 --locked
./build-web.sh
```

On macOS, Apple Clang may lack the WebAssembly target. Install LLVM Clang and LLD, put `wasm-ld` on `PATH`, and set `CC` when building, for example:

```sh
CC=/path/to/llvm/bin/clang ./build-web.sh
```

The built static site is `web/`. Host that directory on HTTPS so phones can open it. For local development on the same machine, `python3 -m http.server 8080 --directory web` and `http://localhost:8080/?teacher` work. A phone cannot use your computer's `localhost`; use an HTTPS host for the classroom.

## Use

1. Open `https://your-host.example/?teacher` in the teacher browser and keep the tab open. The first visit creates the key in that browser.
2. Show the QR code. It links students to the same site with the teacher's Iroh ID and relay URL.
3. Each student appears in the teacher's conversation list. Select a student to see the whole message timeline and send messages in that thread. Students see the same conversation in their chat page.
4. At the end of class, select **End class** and confirm. The teacher sends an end signal to connected students, closes its Iroh endpoint, erases all Please Ask data in that browser, and clears the QR display. Connected students close their endpoints and erase this class's saved chat and key. The ended page stays off after a refresh; **Start a new class** creates a fresh teacher identity and QR code.

For a projector, select **Open QR display** on the teacher page. This opens a separate page that shows only the invitation QR code. Keep the teacher inbox tab open; it owns the Iroh endpoint. The display page can update its code when the teacher tab refreshes in the same browser, using the browser's [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) API.

The teacher page must stay open for live messages. Both browsers save message timelines locally. On reconnect, each side replays its own messages; stable message IDs let the other side fill gaps without adding duplicates. Messages that fail to send remain in the sender's local history and are retried on reconnect. Existing local chat history is migrated when this version first loads. If a connection closes, the student can select **Reconnect**; the teacher sees that student return to the same thread. A student may need to scan the latest QR code if the teacher's relay address changes. Clearing site storage erases saved chat history and keys; using another browser creates a new identity. The host serves only static files; messages travel over authenticated, encrypted Iroh connections. Because browsers cannot use direct UDP, browser Iroh traffic goes through a relay.

The end signal reaches only students connected at that moment. An offline student's browser may retain its local copy of the old chat until that browser's site data is cleared; it cannot join the new class with the old invitation.

The secret key in `localStorage` is accessible to scripts from the same site origin. Host this app on a dedicated origin and avoid adding third-party scripts to the page.
