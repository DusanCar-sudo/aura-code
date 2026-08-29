#!/usr/bin/env python3
"""Record keyboard and mouse events for `:catchthis`.

Reads evdev directly rather than asking the compositor, because Wayland has no
global input monitoring API — by design, and the design is right. Reading
/dev/input works anyway for a user in the `input` group, which is already
required for computer use to inject input at all, so this adds no new privilege
to a machine where computer use is set up.

Emits one JSON object per line on stdout:

    {"t": 1234, "kind": "key", "code": "KEY_A", "value": 1}
    {"t": 1450, "kind": "button", "code": "BTN_LEFT", "value": 1}
    {"t": 1600, "kind": "scroll", "code": "REL_WHEEL", "value": -1}

`t` is milliseconds since recording began. Interpretation happens in
src/record/compile.ts, on purpose: turning press/release pairs into "Ctrl+C" is
the part worth testing, and it should not need a keyboard to test it.

Pointer *motion* is deliberately not recorded. Wayland will not report an
absolute cursor position, so a stream of relative deltas cannot be turned back
into "where the user clicked" — integrating them is defeated by acceleration
and by the pointer hitting a screen edge. The click's location is carried by a
screenshot instead; see src/record/types.ts.

Stops on SIGINT/SIGTERM, or when a line arrives on stdin.
"""

import json
import select
import signal
import sys
import threading
import time

try:
    import evdev
    from evdev import ecodes
except ImportError:
    print(json.dumps({"error": "python3-evdev is not installed. Install it with: "
                               "pip install evdev (or apt install python3-evdev)"}),
          flush=True)
    sys.exit(2)

# Devices Aura itself creates to inject input. Reading them back would record
# the agent's own actions during a replay and grow the recording every run.
OWN_DEVICE_MARKERS = ("aura-", "ydotoold", "py-evdev-uinput")

STOP = threading.Event()


def interesting_devices():
    """Every device that can report a key, a button or a wheel."""
    found = []
    for path in evdev.list_devices():
        try:
            dev = evdev.InputDevice(path)
        except OSError:
            continue  # a device that appeared and went, or one we cannot open
        name = (dev.name or "").lower()
        if any(marker in name for marker in OWN_DEVICE_MARKERS):
            continue
        caps = dev.capabilities()
        if ecodes.EV_KEY in caps or ecodes.EV_REL in caps:
            found.append(dev)
    return found


def code_name(event):
    """The evdev name for an event code, e.g. KEY_A. First name wins when the
    kernel lists aliases (KEY_MIN_INTERESTING and friends)."""
    table = ecodes.bytype.get(event.type, {})
    name = table.get(event.code)
    if isinstance(name, (list, tuple)):
        name = name[0]
    return name or f"{event.type}:{event.code}"


def main():
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: STOP.set())

    devices = interesting_devices()
    if not devices:
        print(json.dumps({"error": "No readable input devices. Add your user to the "
                                   "`input` group and log back in."}), flush=True)
        return 1

    # A line on stdin means stop — the parent's clean way to end the recording
    # without signalling, which keeps the final events from being cut off.
    def watch_stdin():
        try:
            sys.stdin.readline()
        except Exception:
            pass
        STOP.set()
    threading.Thread(target=watch_stdin, daemon=True).start()

    print(json.dumps({"ready": True, "devices": len(devices)}), flush=True)

    fds = {dev.fd: dev for dev in devices}
    known = {dev.path for dev in devices}
    started = time.time()
    next_scan = time.time() + 2.0

    while not STOP.is_set():
        # Devices are enumerated once at startup, so a mouse plugged in — or a
        # Bluetooth keyboard reconnecting — halfway through a demonstration
        # would be silently missing from it. Rescanning costs a directory
        # listing every couple of seconds and removes a failure that looks like
        # "recording just stopped working".
        if time.time() >= next_scan:
            next_scan = time.time() + 2.0
            for dev in interesting_devices():
                if dev.path not in known:
                    known.add(dev.path)
                    fds[dev.fd] = dev
        try:
            readable, _, _ = select.select(list(fds), [], [], 0.25)
        except (OSError, ValueError):
            break  # a device was unplugged mid-recording
        for fd in readable:
            device = fds.get(fd)
            if device is None:
                continue
            try:
                events = list(device.read())
            except OSError:
                fds.pop(fd, None)  # unplugged; keep recording the rest
                continue
            for event in events:
                record = None
                at = int((time.time() - started) * 1000)
                if event.type == ecodes.EV_KEY:
                    name = code_name(event)
                    kind = "button" if str(name).startswith("BTN_") else "key"
                    record = {"t": at, "kind": kind, "code": name, "value": event.value}
                elif event.type == ecodes.EV_REL and event.code in (
                    ecodes.REL_WHEEL, ecodes.REL_HWHEEL,
                ):
                    record = {"t": at, "kind": "scroll",
                              "code": code_name(event), "value": event.value}
                if record is not None:
                    print(json.dumps(record), flush=True)

    print(json.dumps({"done": True}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
