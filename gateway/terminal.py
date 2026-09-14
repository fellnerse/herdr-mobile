"""A direct terminal connection to Herdr, for the phone's console view.

Herdr has two sockets. `herdr.sock` speaks the JSON-RPC the rest of this
gateway uses - it lists panes, reads scrollback, sends keys. `herdr-client.sock`
speaks the client protocol a real Herdr GUI speaks: attach to one terminal and
it streams that terminal's own ANSI, byte for byte, and takes keystrokes back.
That second socket is what makes a console rather than a transcript.

The protocol is ported from herdr-studio's `server/src/bridge/thin-client.ts`
(MIT, (c) 2026 Arthur - see LICENSES/HERDR-STUDIO.txt), which is where the
variant numbering and the 0.8.2/0.9.0 differences below were worked out.

Two shapes of handshake exist:

* Protocol 22 opens with TerminalHello and always answers in ANSI.
* Protocols 14-20 open with Hello, which also carries the encoding we want
  (TerminalAnsi) and a launch mode - the mode moved from 1 to 2 in protocol
  20 when AppDirectGraphics was inserted ahead of it.

Only the ANSI encoding is used here: the semantic frame encoding would mean
compositing cells ourselves, and xterm.js in the browser already is a terminal.
"""

import socket
import struct
import threading

from bincode import BinReader, BinWriter, encode_frame

# ClientMessage variant indices - Herdr's wire.rs enum order.
CM_HELLO = 0
CM_INPUT = 1
CM_RESIZE = 3
CM_ATTACH_TERMINAL = 5
CM_ATTACH_SCROLL = 6

# ServerMessage variant indices. Protocol 22 dropped Frame and two others,
# shifting everything after them down.
SM_LEGACY = {"welcome": 0, "terminal": 2, "shutdown": 4, "clipboard": 6, "mouse": 9}
SM_V22 = {"welcome": 0, "terminal": 1, "shutdown": 3, "clipboard": 5, "mouse": 8}

MIN_PROTOCOL = 14
MAX_PROTOCOL = 22
# Protocol 20 (Herdr 0.8.2) inserted AppDirectGraphics before TerminalAttach.
APP_DIRECT_GRAPHICS_PROTOCOL = 20
# Anything past this is a bug or a hostile peer, not a frame.
MAX_FRAME = 32 * 1024 * 1024
HANDSHAKE_TIMEOUT = 8.0


def supported_protocol(protocol) -> bool:
    """The protocols whose codecs are actually verified here."""
    if not isinstance(protocol, int) or isinstance(protocol, bool):
        return False
    return MIN_PROTOCOL <= protocol <= 20 or protocol == 22


def is_terminal_hello(protocol: int) -> bool:
    return protocol == 22


class TerminalError(Exception):
    pass


class TerminalStream:
    """One attached terminal: ANSI out through `on_data`, keystrokes back in.

    The reader runs on its own thread because the bytes arrive whenever the
    terminal decides to draw, not when the phone asks. Writes are small and
    take the lock; the socket is closed once, from whichever side gets there
    first.
    """

    def __init__(self, socket_path: str, protocol: int, on_data, on_close=None,
                 on_size=None):
        if not supported_protocol(protocol):
            raise TerminalError(f"Herdr protocol {protocol} is not supported here")
        self.socket_path = socket_path
        self.protocol = protocol
        self.sm = SM_V22 if is_terminal_hello(protocol) else SM_LEGACY
        self.on_data = on_data
        self.on_close = on_close
        # The size Herdr is drawing this pane at, which is the desktop's size
        # until somebody asks for another one.
        self.on_size = on_size
        self.size = None
        self._sock = None
        self._send_lock = threading.Lock()
        self._welcomed = threading.Event()
        self._welcome_error = None
        self._closed = False
        self._attached = None
        self._reader = None

    # -- connection ------------------------------------------------------

    def connect(self, cols: int, rows: int):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(HANDSHAKE_TIMEOUT)
        s.connect(self.socket_path)
        self._sock = s
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._send_hello(cols, rows)
        if not self._welcomed.wait(HANDSHAKE_TIMEOUT):
            self.close()
            raise TerminalError("timed out waiting for Herdr's welcome")
        if self._welcome_error:
            self.close()
            raise TerminalError(self._welcome_error)
        # The handshake is the only part with a deadline: a quiet terminal is
        # a normal terminal, and a read timeout would tear the attach down.
        s.settimeout(None)

    def _send(self, payload: bytes):
        with self._send_lock:
            if self._sock is None or self._closed:
                return
            try:
                self._sock.sendall(encode_frame(payload))
            except OSError:
                self.close()

    def _send_hello(self, cols: int, rows: int):
        w = BinWriter()
        w.variant(CM_HELLO)
        w.varint(self.protocol)
        w.varint(cols)
        w.varint(rows)
        w.varint(0)  # cell_width_px - no client-side kitty graphics
        w.varint(0)  # cell_height_px
        if is_terminal_hello(self.protocol):
            # TerminalHello: the encoding, keybindings and launch mode are
            # gone, because a direct terminal connection is always ANSI.
            w.bool(False)  # pixel_mouse
        else:
            w.varint(1)  # requested_encoding: TerminalAnsi
            w.varint(0)  # keybindings: Server
            w.varint(2 if self.protocol >= APP_DIRECT_GRAPHICS_PROTOCOL else 1)
        self._send(w.to_bytes())

    # -- the terminal ----------------------------------------------------

    def attach(self, terminal_id: str, takeover: bool = False):
        """Attach to one terminal. Herdr treats this as a one-time transition
        for the connection, so a second attach needs a second connection."""
        if self._attached == terminal_id:
            return
        if self._attached:
            raise TerminalError(f"already attached to {self._attached}")
        w = BinWriter()
        w.variant(CM_ATTACH_TERMINAL)
        w.string(terminal_id)
        w.bool(takeover)
        self._send(w.to_bytes())
        self._attached = terminal_id

    def input(self, data: bytes):
        w = BinWriter()
        w.variant(CM_INPUT)
        w.bytes(data)
        self._send(w.to_bytes())

    def resize(self, cols: int, rows: int):
        w = BinWriter()
        w.variant(CM_RESIZE)
        w.varint(cols)
        w.varint(rows)
        w.varint(0)
        w.varint(0)
        if is_terminal_hello(self.protocol):
            w.bool(False)  # pixel_mouse
        self._send(w.to_bytes())

    def scroll(self, direction: str, lines: int = 3):
        """Wheel scrolling in the attached terminal's own scrollback."""
        w = BinWriter()
        w.variant(CM_ATTACH_SCROLL)
        w.variant(0)  # AttachScrollSource::Wheel
        w.variant(0 if direction == "up" else 1)
        w.varint(max(1, min(0xFFFF, int(lines))))
        w.option(None, lambda v: w.varint(v))  # column
        w.option(None, lambda v: w.varint(v))  # row
        w.u8(0)  # crossterm KeyModifiers bits
        self._send(w.to_bytes())

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._welcomed.set()
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        if self.on_close:
            try:
                self.on_close()
            except Exception:
                pass

    @property
    def closed(self) -> bool:
        return self._closed

    # -- reading ---------------------------------------------------------

    def _read_loop(self):
        buf = b""
        sock = self._sock
        try:
            while not self._closed:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while len(buf) >= 4:
                    (length,) = struct.unpack("<I", buf[:4])
                    if length > MAX_FRAME:
                        raise TerminalError(f"oversized frame: {length}")
                    if len(buf) < 4 + length:
                        break
                    payload, buf = buf[4:4 + length], buf[4 + length:]
                    self._handle(payload)
        except (OSError, TerminalError, ValueError):
            pass
        finally:
            self.close()

    def _handle(self, payload: bytes):
        r = BinReader(payload)
        variant = r.variant()
        if variant == self.sm["welcome"]:
            version = r.varint()
            encoding = r.varint()
            error = r.option(r.string)
            if error:
                self._welcome_error = f"Herdr refused protocol {self.protocol}: {error}"
            elif version != self.protocol:
                self._welcome_error = (
                    f"Herdr welcomed protocol {version}, expected {self.protocol}")
            elif encoding != 1:
                # Encoding 0 is the semantic frame codec, which this gateway
                # does not composite - it would arrive as cells, not ANSI.
                self._welcome_error = f"Herdr welcomed unsupported encoding {encoding}"
            self._welcomed.set()
        elif variant == self.sm["terminal"]:
            r.varint()   # seq
            width = r.varint()
            height = r.varint()
            r.bool()     # full redraw rather than an incremental update
            data = r.bytes()
            if (width, height) != self.size:
                self.size = (width, height)
                if self.on_size:
                    self.on_size(width, height)
            if data:
                self.on_data(data)
        elif variant == self.sm["shutdown"]:
            self.close()
        # Clipboard, mouse capture, graphics and titles are ignored: the phone
        # has no use for them, and unknown variants are simply not decoded.
