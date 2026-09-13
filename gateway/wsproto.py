"""Just enough RFC 6455 to carry a terminal.

The console needs bytes in both directions with no polling interval in the
middle, which is a WebSocket, and the standard library has no server for one.
It is a small protocol, so here it is: the handshake, the frame header, and
the four opcodes that matter. Extensions are never negotiated, so there is no
compression or fragmentation to reassemble beyond plain continuation frames.

Held to what a terminal needs: one connection per attached pane, text frames
for control messages, binary frames for keystrokes and output.
"""

import base64
import hashlib
import socket
import struct
import threading

# RFC 6455's magic constant, appended to the client key before hashing.
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

# A keystroke is a few bytes and a paste is not a file. Anything larger is a
# mistake or a wedge, and the connection is closed rather than buffered.
MAX_MESSAGE = 1 * 1024 * 1024


class WebSocketError(Exception):
    pass


def is_websocket(headers) -> bool:
    upgrade = (headers.get("Upgrade") or "").lower()
    connection = (headers.get("Connection") or "").lower()
    return upgrade == "websocket" and "upgrade" in connection


def accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


class WebSocket:
    """One accepted connection. `recv` blocks; `send_*` are safe from any
    thread, because the terminal writes from its reader while the request
    thread is still blocked on a read."""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self._send_lock = threading.Lock()
        self._closed = False

    # -- handshake -------------------------------------------------------

    @classmethod
    def accept(cls, handler) -> "WebSocket":
        """Complete the upgrade on a BaseHTTPRequestHandler's connection."""
        key = handler.headers.get("Sec-WebSocket-Key")
        version = handler.headers.get("Sec-WebSocket-Version")
        if not key or (version or "").strip() != "13":
            raise WebSocketError("unsupported WebSocket handshake")
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_key(key)}\r\n"
            "\r\n"
        )
        handler.wfile.write(response.encode("ascii"))
        handler.wfile.flush()
        # The frame loop owns the socket from here; the HTTP layer must not
        # write a response after it or read the next request off it.
        handler.close_connection = True
        sock = handler.connection
        sock.settimeout(None)
        return cls(sock)

    # -- reading ---------------------------------------------------------

    def _read_exactly(self, n: int) -> bytes:
        chunks = []
        got = 0
        while got < n:
            chunk = self.sock.recv(n - got)
            if not chunk:
                raise WebSocketError("connection closed")
            chunks.append(chunk)
            got += len(chunk)
        return b"".join(chunks)

    def _read_frame(self):
        head = self._read_exactly(2)
        fin = bool(head[0] & 0x80)
        opcode = head[0] & 0x0F
        masked = bool(head[1] & 0x80)
        length = head[1] & 0x7F
        if length == 126:
            (length,) = struct.unpack(">H", self._read_exactly(2))
        elif length == 127:
            (length,) = struct.unpack(">Q", self._read_exactly(8))
        if length > MAX_MESSAGE:
            raise WebSocketError(f"frame too large: {length}")
        # Every client frame is masked; an unmasked one is a broken or
        # hostile peer and RFC 6455 says to fail the connection.
        if not masked:
            raise WebSocketError("unmasked frame from client")
        mask = self._read_exactly(4)
        payload = bytearray(self._read_exactly(length))
        for i in range(length):
            payload[i] ^= mask[i & 3]
        return fin, opcode, bytes(payload)

    def recv(self):
        """Return (opcode, payload) for the next message, or None once there
        are no more - the peer closed, the connection dropped, or what arrived
        was not a frame. A violation ends the connection rather than being
        handed up: RFC 6455 says to fail the connection, and the only caller
        would do exactly that with it. Pings are answered here."""
        buf = b""
        message_op = None
        while True:
            try:
                fin, opcode, payload = self._read_frame()
                if opcode == OP_CLOSE:
                    self.close()
                    return None
                if opcode == OP_PING:
                    self._send_frame(OP_PONG, payload)
                    continue
                if opcode == OP_PONG:
                    continue
                if opcode == OP_CONT:
                    if message_op is None:
                        raise WebSocketError("continuation without a message")
                else:
                    message_op = opcode
                    buf = b""
                buf += payload
                if len(buf) > MAX_MESSAGE:
                    raise WebSocketError("message too large")
            except (OSError, WebSocketError):
                self.close()
                return None
            if fin:
                return message_op, buf

    # -- writing ---------------------------------------------------------

    def _send_frame(self, opcode: int, payload: bytes):
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(length)
        elif length <= 0xFFFF:
            header.append(126)
            header += struct.pack(">H", length)
        else:
            header.append(127)
            header += struct.pack(">Q", length)
        with self._send_lock:
            if self._closed:
                return
            try:
                self.sock.sendall(bytes(header) + payload)
            except OSError:
                self.close()

    def send_bytes(self, data: bytes):
        self._send_frame(OP_BINARY, data)

    def send_text(self, text: str):
        self._send_frame(OP_TEXT, text.encode("utf-8"))

    def close(self, code: int = 1000):
        if self._closed:
            return
        with self._send_lock:
            self._closed = True
        try:
            self.sock.sendall(bytes([0x80 | OP_CLOSE, 2]) + struct.pack(">H", code))
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    @property
    def closed(self) -> bool:
        return self._closed
