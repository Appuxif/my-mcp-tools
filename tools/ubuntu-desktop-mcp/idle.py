"""Short-lived GNOME session idle inhibitor.

The first MCP call acquires the GNOME session manager IDLE inhibitor.
Further tool calls extend a 120-second (configurable) lease without any
background polling of the screen, synthetic mouse movement, or settings changes.
When calls stop, the inhibitor is automatically removed. Manual locking works.
"""
from __future__ import annotations

import asyncio
import atexit
import os
import threading
import time

from dbus_next import BusType, Message, MessageType
from dbus_next.aio import MessageBus

DEST = "org.gnome.SessionManager"
PATH = "/org/gnome/SessionManager"
IFACE = "org.gnome.SessionManager"
IDLE_FLAG = 8


class IdleGuard:
    def __init__(self, ttl_seconds: float = 120) -> None:
        if not 2 <= ttl_seconds <= 1800:
            raise ValueError("Idle lease duration must be 2..1800 seconds")
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._deadline = 0.0
        self._thread: threading.Thread | None = None
        self._held = False
        self._error: str | None = None
        self._ready = threading.Event()
        self._stopping = False

    def touch(self) -> None:
        """Extend the idle lease. Fail visibly rather than silently disable protection."""
        with self._lock:
            if self._stopping:
                raise RuntimeError("IdleGuard has been stopped")
            self._deadline = time.monotonic() + self.ttl_seconds
            if self._thread is None:
                self._held = False
                self._error = None
                self._ready = threading.Event()
                self._thread = threading.Thread(
                    target=self._run, args=(self._ready,),
                    name="ubuntu-desktop-idle-lease", daemon=True
                )
                self._thread.start()
            ready = self._ready

        if not ready.wait(timeout=5):
            raise RuntimeError("Could not acquire GNOME idle inhibitor in 5 seconds")
        with self._lock:
            if not self._held:
                raise RuntimeError("GNOME idle inhibitor unavailable: " + (self._error or "not acquired"))

    def status(self) -> dict:
        with self._lock:
            now = time.monotonic()
            return {
                "method": "org.gnome.SessionManager.Inhibit(IDLE)",
                "active": self._held and now < self._deadline,
                "lease_seconds": self.ttl_seconds,
                "remaining_seconds": round(max(0, self._deadline - now), 1)
                if self._held else 0.0,
                "last_error": self._error,
                "manual_lock_allowed": True,
                "behavior": "Every MCP tool call renews this short-lived lease. "
                "It expires automatically after inactivity.",
            }

    def close(self) -> None:
        with self._lock:
            self._stopping = True
            self._deadline = 0.0
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=3)

    def _run(self, ready: threading.Event) -> None:
        try:
            asyncio.run(self._worker(ready))
        except BaseException as exc:
            with self._lock:
                self._error = str(exc)
                self._held = False
                if self._thread is threading.current_thread():
                    self._thread = None
                ready.set()

    async def _call(self, bus: MessageBus, method: str, signature: str, body: list):
        reply = await asyncio.wait_for(
            bus.call(
                Message(
                    destination=DEST, path=PATH, interface=IFACE,
                    member=method, signature=signature, body=body,
                )
            ),
            timeout=3,
        )
        if reply.message_type == MessageType.ERROR:
            raise RuntimeError(f"{method} failed: {reply.body}")
        return reply.body

    async def _worker(self, ready: threading.Event) -> None:
        bus = None
        cookie = None
        try:
            bus = await asyncio.wait_for(
                MessageBus(bus_type=BusType.SESSION).connect(), timeout=3
            )
            response = await self._call(
                bus, "Inhibit", "susu",
                ["ubuntu-desktop-mcp", 0, "AI agent is actively using the desktop", IDLE_FLAG],
            )
            cookie = int(response[0])
            with self._lock:
                self._held = True
                self._error = None
                ready.set()
            while True:
                with self._lock:
                    remaining = self._deadline - time.monotonic()
                    if remaining <= 0 or self._stopping:
                        # Release ownership before notifying new calls. An incoming
                        # call may start its own lease while this one is releasing.
                        if self._thread is threading.current_thread():
                            self._held = False
                            self._thread = None
                        break
                await asyncio.sleep(min(0.25, remaining))
        finally:
            if cookie is not None and bus is not None:
                try:
                    await self._call(bus, "Uninhibit", "u", [cookie])
                except Exception:
                    # D-Bus disconnect also disposes session-owned inhibitors.
                    pass
            if bus is not None:
                bus.disconnect()
            with self._lock:
                if self._thread is threading.current_thread():
                    self._held = False
                    self._thread = None
                ready.set()


def _lease_duration() -> float:
    try:
        return float(os.environ.get("UBUNTU_DESKTOP_IDLE_LEASE_SECONDS", "120"))
    except ValueError as exc:
        raise ValueError("Invalid UBUNTU_DESKTOP_IDLE_LEASE_SECONDS") from exc


idle_guard = IdleGuard(_lease_duration())
atexit.register(idle_guard.close)
