"""Minimal bincode 2.0 (`config::standard()`) codec for Herdr's client socket.

Ported from herdr-studio's `server/src/bridge/bincode.ts` (MIT, (c) 2026
Arthur - see LICENSES/HERDR-STUDIO.txt). The wire format it describes:

Integers are varint:
    value < 251   : one byte, the value
    value <= u16  : 0xfb, then 2 bytes LE
    value <= u32  : 0xfc, then 4 bytes LE
    else          : 0xfd, then 8 bytes LE

`u8` and `bool` are a single raw byte. Enum variant indices and string/bytes
lengths are varint, and strings and byte arrays are length-prefixed. Structs
are their fields in declaration order with no prefix of their own. Options are
a u8 tag (0 = None, 1 = Some) and then the value.
"""

import struct


class BinWriter:
    def __init__(self):
        self._parts = []

    def u8(self, value: int):
        self._parts.append(bytes([value & 0xFF]))

    def bool(self, value: bool):
        self.u8(1 if value else 0)

    def varint(self, value: int):
        if value < 251:
            self.u8(value)
        elif value <= 0xFFFF:
            self.u8(251)
            self._parts.append(struct.pack("<H", value))
        elif value <= 0xFFFFFFFF:
            self.u8(252)
            self._parts.append(struct.pack("<I", value))
        else:
            self.u8(253)
            self._parts.append(struct.pack("<Q", value))

    def string(self, value: str):
        self.bytes(value.encode("utf-8"))

    def bytes(self, data: bytes):
        self.varint(len(data))
        self._parts.append(bytes(data))

    def option(self, value, write):
        if value is None:
            self.u8(0)
        else:
            self.u8(1)
            write(value)

    def variant(self, index: int):
        self.varint(index)

    def to_bytes(self) -> bytes:
        return b"".join(self._parts)


class BinReader:
    def __init__(self, buf: bytes):
        self._buf = buf
        self._off = 0

    def _take(self, n: int) -> bytes:
        end = self._off + n
        if end > len(self._buf):
            raise ValueError(f"bincode: short read at {self._off}, need {n}")
        chunk = self._buf[self._off:end]
        self._off = end
        return chunk

    def u8(self) -> int:
        return self._take(1)[0]

    def bool(self) -> bool:
        return self.u8() != 0

    def varint(self) -> int:
        first = self.u8()
        if first < 251:
            return first
        if first == 251:
            return struct.unpack("<H", self._take(2))[0]
        if first == 252:
            return struct.unpack("<I", self._take(4))[0]
        if first == 253:
            return struct.unpack("<Q", self._take(8))[0]
        raise ValueError(f"bincode: invalid varint marker {first}")

    def string(self) -> str:
        return self.bytes().decode("utf-8", errors="replace")

    def bytes(self) -> bytes:
        return self._take(self.varint())

    def option(self, read):
        return read() if self.u8() == 1 else None

    def variant(self) -> int:
        return self.varint()

    @property
    def remaining(self) -> int:
        return len(self._buf) - self._off


def encode_frame(payload: bytes) -> bytes:
    """Length-prefixed frame: u32 LE payload length, then the payload."""
    return struct.pack("<I", len(payload)) + payload
