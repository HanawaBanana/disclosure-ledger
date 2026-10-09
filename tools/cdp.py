#!/usr/bin/env python3
"""A very small Chrome DevTools Protocol client (standard library only).

`headless Chrome --screenshot` captures the page before an asynchronous
interface has finished rendering, which makes it useless for recording a single
page application: half the frames come out blank. Driving the browser instead
lets us wait until the page says it is ready (`data-metrics` in app/main.js) and
then capture the full page height.

    from cdp import Browser
    with Browser(width=1280, height=900) as browser:
        page = browser.new_page()
        page.navigate(url)
        page.wait_for("document.body.dataset.metrics || ''")
        metrics = json.loads(page.evaluate("document.body.dataset.metrics"))
        page.screenshot("frame.png")

Implements just enough of RFC 6455 to talk to the DevTools endpoint: a masked
text client that handles ping, continuation frames, and 16/64-bit lengths.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

CHROME = os.environ.get(
    "CHROME_BIN",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)


class CdpError(RuntimeError):
    pass


class _Socket:
    """Minimal WebSocket client for the DevTools endpoint."""

    def __init__(self, ws_url, timeout=60.0):
        parsed = urlparse(ws_url)
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80
        path = parsed.path + (("?" + parsed.query) if parsed.query else "")
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ) % (path, self.host, self.port, key)
        self.sock.sendall(request.encode())
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise CdpError("the DevTools socket closed during the handshake")
            header += chunk
        if b" 101 " not in header.split(b"\r\n")[0]:
            raise CdpError("DevTools refused the WebSocket handshake: %s" % header.split(b"\r\n")[0])
        self.buffer = header.split(b"\r\n\r\n", 1)[1]
        self._id = 0

    def _recv_exact(self, count):
        data = self.buffer[:count]
        self.buffer = self.buffer[count:]
        while len(data) < count:
            chunk = self.sock.recv(min(65536, count - len(data)))
            if not chunk:
                raise CdpError("the DevTools socket closed")
            data += chunk
        return data

    def _read_frame(self):
        first, second = self._recv_exact(2)
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else None
        payload = self._recv_exact(length) if length else b""
        if mask:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return fin, opcode, payload

    def _send_text(self, text):
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        header += mask
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def call(self, method, params=None, timeout=60.0):
        self._id += 1
        message_id = self._id
        self._send_text(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x9:                      # ping
                self.sock.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0x8:
                raise CdpError("the DevTools socket was closed by the browser")
            if opcode not in (0x1, 0x2):
                continue
            while not fin:
                fin, opcode, more = self._read_frame()
                payload += more
            message = json.loads(payload.decode("utf-8"))
            if message.get("id") == message_id:
                if "error" in message:
                    raise CdpError("%s: %s" % (method, message["error"]))
                return message.get("result", {})
        raise CdpError("timed out waiting for %s" % method)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Page:
    def __init__(self, socket_client):
        self.cdp = socket_client

    def navigate(self, url):
        self.cdp.call("Page.navigate", {"url": url})

    def evaluate(self, expression):
        result = self.cdp.call("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
        })
        return result.get("result", {}).get("value")

    def wait_for(self, expression, timeout=45.0, poll=0.25):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = self.evaluate(expression)
            if last:
                return last
            time.sleep(poll)
        return last

    def screenshot(self, path):
        result = self.cdp.call("Page.captureScreenshot", {
            "format": "png", "captureBeyondViewport": True,
        }, timeout=120.0)
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(result["data"]))
        return path


class Browser:
    """Launches headless Chrome and exposes one page over CDP."""

    def __init__(self, width=1280, height=2600, port=None, chrome=None):
        self.chrome = chrome or CHROME
        self.width = width
        self.height = height
        self.port = port or (9333 + (os.getpid() % 300))
        self.profile = tempfile.mkdtemp(prefix="dl-cdp-")
        self.process = None
        self.page = None

    def __enter__(self):
        if not os.path.exists(self.chrome):
            raise CdpError("Chrome was not found at %s" % self.chrome)
        self.process = subprocess.Popen([
            self.chrome, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--hide-scrollbars",
            "--window-size=%d,%d" % (self.width, self.height),
            "--user-data-dir=" + self.profile,
            "--remote-debugging-port=%d" % self.port,
            "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = None
        deadline = time.time() + 30
        while time.time() < deadline and not target:
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % self.port, timeout=2) as response:
                    targets = json.load(response)
                for candidate in targets:
                    if candidate.get("type") == "page" and candidate.get("webSocketDebuggerUrl"):
                        target = candidate["webSocketDebuggerUrl"]
                        break
            except Exception:
                time.sleep(0.2)
        if not target:
            self.__exit__(None, None, None)
            raise CdpError("Chrome did not expose a debugging target on port %d" % self.port)
        client = _Socket(target)
        client.call("Page.enable")
        client.call("Runtime.enable")
        self.page = Page(client)
        return self

    def new_page(self):
        return self.page

    def __exit__(self, *_):
        if self.page:
            try:
                self.page.cdp.close()
            except Exception:
                pass
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except Exception:
                self.process.kill()
        shutil.rmtree(self.profile, ignore_errors=True)
        return False


if __name__ == "__main__":
    import sys
    url = sys.argv[1] if len(sys.argv) > 1 else "about:blank"
    with Browser() as browser:
        page = browser.new_page()
        page.navigate(url)
        print(page.evaluate("document.title"))
