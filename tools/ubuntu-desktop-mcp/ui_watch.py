"""Wait for interface changes using AT-SPI events, without taking screenshots.

Unlike polling an accessibility tree or capturing the desktop in a loop,
this registers with the session's AT-SPI bus and sleeps until an event arrives.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from a11y import Atspi
from gi.repository import GLib

WATCH_EVENTS = (
    "object:children-changed",
    "object:text-changed",
    "object:property-change:accessible-name",
    "object:state-changed:showing",
    "window:activate",
)


class AccessibilityWatcher:
    def __init__(self, app_filter: str = "", event_contains: str = "",
                 element_contains: str = "") -> None:
        self.app_filter = app_filter.casefold()
        self.event_contains = event_contains.casefold()
        self.element_contains = element_contains.casefold()
        self._ready = threading.Event()
        self._change = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._error: str | None = None
        self._record: dict[str, Any] | None = None
        self._registered: list[str] = []
        self._loop = None
        self._start = time.monotonic()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="atspi-ui-watcher", daemon=True)
        self._thread.start()
        if not self._ready.wait(5):
            self.close()
            raise RuntimeError("AT-SPI listener did not start within 5 seconds")
        if self._error:
            self.close()
            raise RuntimeError("AT-SPI listener failed: " + self._error)

    def _on_event(self, event, *args) -> None:
        try:
            if self._stop.is_set() or self._change.is_set():
                return
            source = getattr(event, "source", None)
            if source is None:
                return
            app = ""
            try:
                application = source.get_application()
                app = application.get_name() if application is not None else ""
            except Exception:
                pass
            if self.app_filter and self.app_filter not in app.casefold():
                return
            if not app:
                # Ignore stale/defunct tree events that cannot be associated
                # with a concrete accessible application.
                return
            kind = str(event.type)
            if self.event_contains and self.event_contains not in kind.casefold():
                return
            name = ""
            role = ""
            try:
                name = source.get_name() or ""
                role = source.get_role_name() or ""
            except Exception:
                pass
            if self.element_contains and self.element_contains not in name.casefold():
                return
            self._record = {
                "event": kind,
                "application": app,
                "element": name[:200],
                "role": role,
                "elapsed_ms": round((time.monotonic() - self._start) * 1000),
            }
            self._change.set()
            if self._loop is not None:
                self._loop.quit()
        except Exception as exc:
            self._error = str(exc)

    def _run(self) -> None:
        listener = None
        try:
            listener = Atspi.EventListener.new(self._on_event)
            for name in WATCH_EVENTS:
                if listener.register(name):
                    self._registered.append(name)
            if not self._registered:
                raise RuntimeError("No supported AT-SPI event types could be registered")
            self._loop = GLib.MainLoop()
            self._ready.set()

            def should_exit():
                if self._stop.is_set():
                    self._loop.quit()
                    return GLib.SOURCE_REMOVE
                return GLib.SOURCE_CONTINUE

            source_id = GLib.timeout_add(100, should_exit)
            try:
                self._loop.run()
            finally:
                if GLib.MainContext.default().find_source_by_id(source_id):
                    GLib.source_remove(source_id)
        except Exception as exc:
            self._error = str(exc)
            self._ready.set()
        finally:
            if listener is not None:
                for name in self._registered:
                    try:
                        listener.deregister(name)
                    except Exception:
                        pass

    def wait(self, seconds: float) -> dict[str, Any] | None:
        if not self._change.wait(seconds):
            return None
        return self._record

    def close(self) -> None:
        self._stop.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=3)
