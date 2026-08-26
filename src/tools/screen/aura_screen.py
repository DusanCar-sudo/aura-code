#!/usr/bin/env python3
"""Screen capture and input injection sidecar for Aura computer use (Linux).

Why a separate process at all: both halves need state that cannot survive a
one-shot call. The XDG ScreenCast session dies with the D-Bus connection that
created it, and the uinput device disappears when its file descriptor closes —
so `busctl call` per screenshot, or a fresh `ydotool` per click, cannot work.
This process holds both open and takes commands on stdin.

Why Python: it is the only runtime on a normal Linux box with both GLib/Gio
(persistent D-Bus) and evdev (uinput) already installed. Node has neither, and
adding them would mean native npm dependencies in a published package, which
this repo's standards forbid.

Protocol: one JSON object per line in, one JSON object per line out. stdout is
reserved for those replies — everything else goes to stderr.

Input goes through our own uinput device rather than the compositor. Measured
on KDE Plasma 6.6 / Wayland while building this, three other paths accept the
call and silently do nothing: xdotool cannot see Wayland at all; ydotool 1.0.4
creates a relative-only device (EV=7, no EV_ABS) so `mousemove -a` is a no-op;
and the RemoteDesktop portal's NotifyPointerMotionAbsolute is ignored because
Plasma 6 routes input through libei instead. A uinput device with real ABS axes
sits below all of that and is the one thing that worked.
"""
import json
import os
import random
import subprocess
import sys
import time

import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gio, GLib, Gst          # noqa: E402
from evdev import UInput, AbsInfo, ecodes as e    # noqa: E402

PORTAL = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
RD = "org.freedesktop.portal.RemoteDesktop"
SC = "org.freedesktop.portal.ScreenCast"


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class Portal:
    """Owns the ScreenCast session and pulls frames from its PipeWire stream."""

    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = None
        self.node = None
        self.width = 0
        self.height = 0
        self.sink = None
        self.pipeline = None

    def _token(self):
        return "aura%d" % random.randint(0, 2 ** 31)

    def _call(self, iface, method, params_fn, timeout=120):
        """Portal calls answer on a Request object's Response signal, not as a
        return value, so each one is a subscribe-then-call round trip."""
        loop = GLib.MainLoop()
        out = {}
        tok = self._token()
        sender = self.bus.get_unique_name()[1:].replace(".", "_")
        req = f"/org/freedesktop/portal/desktop/request/{sender}/{tok}"
        sub = {}

        def handler(_c, _s, _p, _i, _sig, params):
            self.bus.signal_unsubscribe(sub["id"])
            out["code"], out["results"] = params.unpack()
            loop.quit()

        sub["id"] = self.bus.signal_subscribe(
            PORTAL, "org.freedesktop.portal.Request", "Response", req, None, 0, handler)
        self.bus.call_sync(PORTAL, PATH, iface, method, params_fn(tok), None, 0, -1, None)
        GLib.timeout_add_seconds(timeout, lambda: (loop.quit(), False)[1])
        loop.run()
        if "code" not in out:
            raise RuntimeError(f"{method}: timed out waiting for the portal dialog")
        if out["code"] != 0:
            raise RuntimeError(f"{method}: refused (code {out['code']}; 1 = cancelled)")
        return out["results"]

    def start(self):
        stok = self._token()
        r = self._call(RD, "CreateSession", lambda t: GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", t),
            "session_handle_token": GLib.Variant("s", stok)},)))
        self.session = r["session_handle"]

        # KEYBOARD|POINTER. We do not use the portal's input methods (see the
        # module docstring), but selecting devices is what makes it hand back a
        # session that also carries a screen stream.
        self._call(RD, "SelectDevices", lambda t: GLib.Variant("(oa{sv})", (
            self.session, {"handle_token": GLib.Variant("s", t),
                           "types": GLib.Variant("u", 3)})))
        self._call(SC, "SelectSources", lambda t: GLib.Variant("(oa{sv})", (
            self.session, {"handle_token": GLib.Variant("s", t),
                           "types": GLib.Variant("u", 1),        # MONITOR
                           "multiple": GLib.Variant("b", False),
                           "cursor_mode": GLib.Variant("u", 2)})))  # EMBEDDED
        res = self._call(RD, "Start", lambda t: GLib.Variant("(osa{sv})", (
            self.session, "", {"handle_token": GLib.Variant("s", t)})))

        streams = res.get("streams") or []
        if not streams:
            raise RuntimeError("portal granted no screen stream")
        self.node, props = streams[0]
        size = props.get("size") or (0, 0)
        self.width, self.height = int(size[0]), int(size[1])

        Gst.init(None)
        self.pipeline = Gst.parse_launch(
            f"pipewiresrc path={self.node} ! videoconvert ! video/x-raw,format=RGB ! "
            f"appsink name=sink max-buffers=1 drop=true sync=false")
        self.sink = self.pipeline.get_by_name("sink")
        self.pipeline.set_state(Gst.State.PLAYING)
        self.pipeline.get_state(Gst.SECOND * 10)

    def frame(self):
        """Newest frame as (rgb_bytes, width, height), rows already de-padded."""
        sample = None
        for _ in range(6):          # drain stale buffers so we get current state
            sample = self.sink.emit("try-pull-sample", Gst.SECOND * 5) or sample
        if sample is None:
            raise RuntimeError("no frame from the screen stream")
        caps = sample.get_caps().get_structure(0)
        w, h = caps.get_value("width"), caps.get_value("height")
        buf = sample.get_buffer()
        ok, info = buf.map(Gst.MapFlags.READ)
        data = bytes(info.data)
        buf.unmap(info)

        # PipeWire aligns each row, so the buffer is wider than w*3 and feeding
        # it to an image encoder unaltered truncates the picture mid-frame.
        want = w * h * 3
        if len(data) != want:
            stride = len(data) // h
            if stride < w * 3:
                raise RuntimeError(f"frame buffer too small: {len(data)} for {w}x{h}")
            data = b"".join(data[r * stride: r * stride + w * 3] for r in range(h))
        return data, w, h

    def close(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)


# ── keyboard ────────────────────────────────────────────────────────────────
# Only what a US layout can reach without dead keys. Anything outside this is
# reported back rather than silently dropped: a half-typed string is worse than
# a refusal, because the agent cannot tell it happened.
_UNSHIFTED = {
    **{c: getattr(e, f"KEY_{c.upper()}") for c in "abcdefghijklmnopqrstuvwxyz"},
    **{c: getattr(e, f"KEY_{c}") for c in "0123456789"},
    " ": e.KEY_SPACE, "\t": e.KEY_TAB, "\n": e.KEY_ENTER, "-": e.KEY_MINUS,
    "=": e.KEY_EQUAL, "[": e.KEY_LEFTBRACE, "]": e.KEY_RIGHTBRACE,
    "\\": e.KEY_BACKSLASH, ";": e.KEY_SEMICOLON, "'": e.KEY_APOSTROPHE,
    "`": e.KEY_GRAVE, ",": e.KEY_COMMA, ".": e.KEY_DOT, "/": e.KEY_SLASH,
}
_SHIFTED = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
    "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
    "|": "\\", ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
    **{c.upper(): c for c in "abcdefghijklmnopqrstuvwxyz"},
}
_NAMED = {
    "enter": e.KEY_ENTER, "return": e.KEY_ENTER, "tab": e.KEY_TAB,
    "escape": e.KEY_ESC, "esc": e.KEY_ESC, "backspace": e.KEY_BACKSPACE,
    "delete": e.KEY_DELETE, "space": e.KEY_SPACE, "up": e.KEY_UP,
    "down": e.KEY_DOWN, "left": e.KEY_LEFT, "right": e.KEY_RIGHT,
    "home": e.KEY_HOME, "end": e.KEY_END, "pageup": e.KEY_PAGEUP,
    "pagedown": e.KEY_PAGEDOWN, "insert": e.KEY_INSERT,
    **{f"f{i}": getattr(e, f"KEY_F{i}") for i in range(1, 13)},
}
_MODS = {"ctrl": e.KEY_LEFTCTRL, "control": e.KEY_LEFTCTRL,
         "alt": e.KEY_LEFTALT, "shift": e.KEY_LEFTSHIFT,
         "super": e.KEY_LEFTMETA, "meta": e.KEY_LEFTMETA, "cmd": e.KEY_LEFTMETA}

_BUTTONS = {"left": e.BTN_LEFT, "right": e.BTN_RIGHT, "middle": e.BTN_MIDDLE}


class Input:
    """A virtual absolute pointer + keyboard, created directly on /dev/uinput."""

    def __init__(self, width, height):
        self.w, self.h = width, height
        keys = sorted(set(
            list(_UNSHIFTED.values()) + list(_NAMED.values()) + list(_MODS.values())
            + list(_BUTTONS.values())))
        caps = {
            e.EV_KEY: keys,
            e.EV_ABS: [(e.ABS_X, AbsInfo(0, 0, width, 0, 0, 0)),
                       (e.ABS_Y, AbsInfo(0, 0, height, 0, 0, 0))],
            e.EV_REL: [e.REL_WHEEL, e.REL_HWHEEL],
        }
        self.ui = UInput(caps, name="aura-virtual-pointer", version=1)
        # udev has to notice the device and the compositor has to bind it before
        # the first event will land anywhere. Without this the opening move of a
        # session is silently lost.
        time.sleep(1.2)

    def move(self, x, y):
        x = max(0, min(int(x), self.w))
        y = max(0, min(int(y), self.h))
        self.ui.write(e.EV_ABS, e.ABS_X, x)
        self.ui.write(e.EV_ABS, e.ABS_Y, y)
        self.ui.syn()

    def click(self, button="left", count=1):
        btn = _BUTTONS.get(button)
        if btn is None:
            raise ValueError(f"unknown button: {button}")
        for i in range(count):
            self.ui.write(e.EV_KEY, btn, 1)
            self.ui.syn()
            time.sleep(0.04)
            self.ui.write(e.EV_KEY, btn, 0)
            self.ui.syn()
            if i + 1 < count:
                time.sleep(0.08)      # inside the double-click threshold

    def drag(self, x1, y1, x2, y2):
        self.move(x1, y1)
        time.sleep(0.1)
        self.ui.write(e.EV_KEY, e.BTN_LEFT, 1)
        self.ui.syn()
        time.sleep(0.1)
        # Interpolate: a single jump reads as a teleport and most drag handlers
        # never see a motion event between press and release.
        for i in range(1, 11):
            self.move(x1 + (x2 - x1) * i / 10.0, y1 + (y2 - y1) * i / 10.0)
            time.sleep(0.02)
        self.ui.write(e.EV_KEY, e.BTN_LEFT, 0)
        self.ui.syn()

    def scroll(self, dy=0, dx=0):
        for _ in range(abs(int(dy))):
            self.ui.write(e.EV_REL, e.REL_WHEEL, 1 if dy > 0 else -1)
            self.ui.syn()
            time.sleep(0.01)
        for _ in range(abs(int(dx))):
            self.ui.write(e.EV_REL, e.REL_HWHEEL, 1 if dx > 0 else -1)
            self.ui.syn()
            time.sleep(0.01)

    def _tap(self, code, mods=()):
        for m in mods:
            self.ui.write(e.EV_KEY, m, 1)
        self.ui.write(e.EV_KEY, code, 1)
        self.ui.syn()
        time.sleep(0.012)
        self.ui.write(e.EV_KEY, code, 0)
        for m in reversed(mods):
            self.ui.write(e.EV_KEY, m, 0)
        self.ui.syn()
        time.sleep(0.012)

    def type_text(self, text):
        unsupported = []
        for ch in text:
            if ch in _UNSHIFTED:
                self._tap(_UNSHIFTED[ch])
            elif ch in _SHIFTED:
                self._tap(_UNSHIFTED[_SHIFTED[ch]], (e.KEY_LEFTSHIFT,))
            else:
                unsupported.append(ch)
        return unsupported

    def key(self, combo):
        """'ctrl+c', 'alt+tab', 'enter' — modifiers first, one final key."""
        parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
        if not parts:
            raise ValueError("empty key combo")
        *mod_names, final = parts
        mods = []
        for m in mod_names:
            if m not in _MODS:
                raise ValueError(f"unknown modifier: {m}")
            mods.append(_MODS[m])
        if final in _NAMED:
            code = _NAMED[final]
        elif final in _UNSHIFTED:
            code = _UNSHIFTED[final]
        elif final in _SHIFTED:
            code = _UNSHIFTED[_SHIFTED[final]]
            mods.append(e.KEY_LEFTSHIFT)
        else:
            raise ValueError(f"unknown key: {final}")
        self._tap(code, tuple(mods))

    def close(self):
        try:
            self.ui.close()
        except Exception:
            pass


def encode_png(data, w, h, out_path, max_pixels):
    """Raw RGB -> downscaled PNG, via ImageMagick so nothing new is installed."""
    scale = min(1.0, (max_pixels / float(w * h)) ** 0.5) if max_pixels else 1.0
    tw, th = max(1, int(w * scale)), max(1, int(h * scale))
    p = subprocess.run(
        ["convert", "-size", f"{w}x{h}", "-depth", "8", "RGB:-",
         "-resize", f"{tw}x{th}!", out_path],
        input=data, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("convert failed: " + p.stderr.decode()[:200])
    return tw, th, scale


def die_with_parent():
    """Ask the kernel to SIGTERM us the moment Aura dies, however it dies.

    Without this the sidecar is an orphan whenever the parent does not get to
    run its cleanup — a SIGKILL, an OOM kill, a crash, or simply Node's `exit`
    event, which cannot await an async close. Observed in practice: two of
    these were found still alive hours after their sessions ended, each holding
    an open /dev/uinput descriptor (a live virtual keyboard and mouse) and a
    PipeWire screen stream. A leaked capture session is a privacy fault, not
    just an untidy process table, so the guarantee belongs in the kernel rather
    than in a handler the parent may never reach.

    Best-effort by design: PR_SET_PDEATHSIG is Linux-only, and this sidecar is
    already Linux-only. If it is unavailable the explicit close path still
    works, so a failure here must not stop the process from starting.
    """
    try:
        import ctypes
        PR_SET_PDEATHSIG = 1
        SIGTERM = 15
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0)
        # The parent can die between spawn and this call, in which case the
        # signal was already missed and we would linger forever anyway.
        if os.getppid() == 1:
            os._exit(0)
    except Exception as exc:                                    # noqa: BLE001
        print(f"pdeathsig unavailable: {exc}", file=sys.stderr, flush=True)


def main():
    die_with_parent()
    portal = None
    inp = None
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                cmd = req.get("cmd")

                if cmd == "init":
                    portal = Portal()
                    portal.start()
                    inp = Input(portal.width, portal.height)
                    reply({"ok": True, "width": portal.width, "height": portal.height})

                elif portal is None or inp is None:
                    reply({"ok": False, "error": "not initialised — send init first"})

                elif cmd == "capture":
                    data, w, h = portal.frame()
                    out = req.get("path") or "/tmp/aura-screen.png"
                    tw, th, scale = encode_png(data, w, h, out, req.get("max_pixels", 1_100_000))
                    reply({"ok": True, "path": out, "width": tw, "height": th,
                           "source_width": w, "source_height": h, "scale": scale})

                elif cmd == "move":
                    inp.move(req["x"], req["y"]);  reply({"ok": True})

                elif cmd == "click":
                    if "x" in req and req["x"] is not None:
                        inp.move(req["x"], req["y"]); time.sleep(0.12)
                    inp.click(req.get("button", "left"), int(req.get("count", 1)))
                    reply({"ok": True})

                elif cmd == "drag":
                    inp.drag(req["x1"], req["y1"], req["x2"], req["y2"]); reply({"ok": True})

                elif cmd == "scroll":
                    inp.scroll(req.get("dy", 0), req.get("dx", 0)); reply({"ok": True})

                elif cmd == "type":
                    bad = inp.type_text(req["text"])
                    reply({"ok": True, **({"unsupported": "".join(bad)} if bad else {})})

                elif cmd == "key":
                    inp.key(req["combo"]); reply({"ok": True})

                elif cmd == "close":
                    reply({"ok": True}); break

                else:
                    reply({"ok": False, "error": f"unknown command: {cmd}"})
            except Exception as ex:                      # one bad command must
                reply({"ok": False, "error": f"{type(ex).__name__}: {ex}"})   # not kill the sidecar
    finally:
        if inp:
            inp.close()
        if portal:
            portal.close()


if __name__ == "__main__":
    main()
