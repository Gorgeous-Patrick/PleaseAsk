pub const ALPN: &[u8] = b"pleaseask/classroom-chat/3";
pub const MAX_FRAME_BYTES: usize = 32 * 1024;

#[cfg(target_arch = "wasm32")]
mod student;
