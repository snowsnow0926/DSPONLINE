use std::io::{self, Read, Write};

use crc32fast::Hasher;
use thiserror::Error;

pub const FRAME_MAGIC: [u8; 8] = *b"DSPNATV1";
pub const FRAME_HEADER_BYTES: usize = 32;
pub const MAX_FRAME_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum FrameKind {
    ControlRequest = 1,
    ControlResponse = 2,
    BinaryRequest = 3,
    BinaryResponse = 4,
    Event = 5,
}

impl TryFrom<u16> for FrameKind {
    type Error = FrameError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::ControlRequest),
            2 => Ok(Self::ControlResponse),
            3 => Ok(Self::BinaryRequest),
            4 => Ok(Self::BinaryResponse),
            5 => Ok(Self::Event),
            _ => Err(FrameError::UnknownKind(value)),
        }
    }
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("native frame magic is invalid")]
    InvalidMagic,
    #[error("native protocol version {0} is unsupported")]
    UnsupportedVersion(u16),
    #[error("native frame kind {0} is unsupported")]
    UnknownKind(u16),
    #[error("native frame payload exceeds the bounded IPC limit")]
    PayloadTooLarge,
    #[error("native frame checksum is invalid")]
    InvalidChecksum,
    #[error(transparent)]
    Io(#[from] io::Error),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub protocol_version: u16,
    pub kind: FrameKind,
    pub flags: u32,
    pub request_id: u64,
    pub sequence: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn control_request(request_id: u64, payload: Vec<u8>) -> Self {
        Self {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            kind: FrameKind::ControlRequest,
            flags: 0,
            request_id,
            sequence: 0,
            payload,
        }
    }

    pub fn control_response(request_id: u64, payload: Vec<u8>) -> Self {
        Self {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            kind: FrameKind::ControlResponse,
            flags: 0,
            request_id,
            sequence: 0,
            payload,
        }
    }
}

fn checksum(payload: &[u8]) -> u32 {
    let mut hasher = Hasher::new();
    hasher.update(payload);
    hasher.finalize()
}

pub fn write_frame(mut writer: impl Write, frame: &Frame) -> Result<(), FrameError> {
    if frame.payload.len() > MAX_FRAME_PAYLOAD_BYTES {
        return Err(FrameError::PayloadTooLarge);
    }
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    header[0..8].copy_from_slice(&FRAME_MAGIC);
    header[8..10].copy_from_slice(&frame.protocol_version.to_le_bytes());
    header[10..12].copy_from_slice(&(frame.kind as u16).to_le_bytes());
    header[12..16].copy_from_slice(&frame.flags.to_le_bytes());
    header[16..24].copy_from_slice(&frame.request_id.to_le_bytes());
    header[24..28].copy_from_slice(&frame.sequence.to_le_bytes());
    header[28..32].copy_from_slice(&(frame.payload.len() as u32).to_le_bytes());
    writer.write_all(&header)?;
    writer.write_all(&checksum(&frame.payload).to_le_bytes())?;
    writer.write_all(&frame.payload)?;
    writer.flush()?;
    Ok(())
}

pub fn read_frame(mut reader: impl Read) -> Result<Option<Frame>, FrameError> {
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    let mut offset = 0;
    while offset < header.len() {
        match reader.read(&mut header[offset..]) {
            Ok(0) if offset == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "partial native frame header",
                )
                .into());
            }
            Ok(read) => offset += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    if header[0..8] != FRAME_MAGIC {
        return Err(FrameError::InvalidMagic);
    }
    let protocol_version = u16::from_le_bytes(header[8..10].try_into().expect("fixed slice"));
    if protocol_version != crate::NATIVE_PROTOCOL_VERSION {
        return Err(FrameError::UnsupportedVersion(protocol_version));
    }
    let kind = FrameKind::try_from(u16::from_le_bytes(
        header[10..12].try_into().expect("fixed slice"),
    ))?;
    let flags = u32::from_le_bytes(header[12..16].try_into().expect("fixed slice"));
    let request_id = u64::from_le_bytes(header[16..24].try_into().expect("fixed slice"));
    let sequence = u32::from_le_bytes(header[24..28].try_into().expect("fixed slice"));
    let payload_length =
        u32::from_le_bytes(header[28..32].try_into().expect("fixed slice")) as usize;
    if payload_length > MAX_FRAME_PAYLOAD_BYTES {
        return Err(FrameError::PayloadTooLarge);
    }
    let mut checksum_bytes = [0_u8; 4];
    reader.read_exact(&mut checksum_bytes)?;
    let expected_checksum = u32::from_le_bytes(checksum_bytes);
    let mut payload = vec![0_u8; payload_length];
    reader.read_exact(&mut payload)?;
    if checksum(&payload) != expected_checksum {
        return Err(FrameError::InvalidChecksum);
    }
    Ok(Some(Frame {
        protocol_version,
        kind,
        flags,
        request_id,
        sequence,
        payload,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_is_exact() {
        let frame = Frame {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            kind: FrameKind::BinaryRequest,
            flags: 7,
            request_id: 42,
            sequence: 3,
            payload: vec![0, 1, 2, 250, 255],
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &frame).unwrap();
        assert_eq!(read_frame(bytes.as_slice()).unwrap(), Some(frame));
    }

    #[test]
    fn corrupt_payload_is_rejected() {
        let frame = Frame::control_request(1, b"hello".to_vec());
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &frame).unwrap();
        *bytes.last_mut().unwrap() ^= 0xff;
        assert!(matches!(
            read_frame(bytes.as_slice()),
            Err(FrameError::InvalidChecksum)
        ));
    }
}
