"""Regression tests for event-driven and visual change detection."""
from __future__ import annotations

import asyncio
import io
import json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from PIL import Image as PILImage

import server
import ui_watch
import visual_watch


def png(fill=(40, 40, 40), changed=False) -> bytes:
    img = PILImage.new("RGB", (160, 100), fill)
    if changed:
        for x in range(30, 90):
            for y in range(20, 80):
                img.putpixel((x, y), (235, 235, 235))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.activity = patch.object(server.idle_guard, "touch")
        self.activity.start()
        self.addCleanup(self.activity.stop)

    def test_visual_image_difference(self):
        before = visual_watch.prepare(png())
        after = visual_watch.prepare(png(changed=True))
        self.assertEqual(visual_watch.compare(before, before)["changed_fraction"], 0)
        metrics = visual_watch.compare(before, after)
        self.assertGreater(metrics["changed_fraction"], 0.2)
        self.assertGreater(metrics["mean_difference"], 10)
        with self.assertRaises(ValueError):
            visual_watch.prepare(png(), region=(200, 0, 10, 10))

    def test_event_wait_needs_no_screenshots(self):
        watcher = MagicMock()
        watcher.wait.return_value = {
            "event": "object:children-changed:add",
            "application": "Google Chrome",
            "element": "dialog",
            "role": "dialog",
            "elapsed_ms": 120,
        }
        with patch.object(server.ui_watch, "AccessibilityWatcher", return_value=watcher), \
             patch.object(server.a11y, "active_window", return_value={
                 "found": True, "app": "Google Chrome",
             }), \
             patch.object(server, "_portal_screenshot", new_callable=AsyncMock) as screenshot:
            reply = asyncio.run(server.wait_for_change(timeout_seconds=2))
        state = json.loads(reply.content[0].text)
        self.assertTrue(state["changed"])
        self.assertEqual(state["screenshots_compared"], 0)
        self.assertEqual(len(reply.content), 1)
        screenshot.assert_not_called()
        watcher.start.assert_called_once()
        watcher.close.assert_called_once()

    def test_event_timeout_without_image(self):
        watcher = MagicMock()
        watcher.wait.return_value = None
        with patch.object(server.ui_watch, "AccessibilityWatcher", return_value=watcher), \
             patch.object(server.a11y, "active_window", return_value={
                 "found": True, "app": "Google Chrome",
             }):
            reply = asyncio.run(server.wait_for_change(timeout_seconds=0.5, screenshot_after=True))
        state = json.loads(reply.content[0].text)
        self.assertFalse(state["changed"])
        self.assertTrue(state["timeout"])
        self.assertEqual(len(reply.content), 1)

    def test_visual_wait_captures_locally_and_returns_metadata_only(self):
        fake_pngs = [png(), png(changed=True)]
        with patch.object(server, "_portal_screenshot", new=AsyncMock(side_effect=fake_pngs)) as grab:
            reply = asyncio.run(server.wait_for_change(
                mode="visual", timeout_seconds=2, interval_ms=400,
                stable_checks=1, change_fraction=0.03,
                screenshot_after=False,
            ))
        state = json.loads(reply.content[0].text)
        self.assertTrue(state["changed"])
        self.assertEqual(state["screenshots_compared"], 1)
        self.assertEqual(len(reply.content), 1)
        self.assertEqual(grab.await_count, 2)

    def test_invalid_modes_and_limits(self):
        for params in [
            {"mode": "unknown"},
            {"timeout_seconds": 0.1},
            {"region": [0, 1, 2]},
            {"stable_checks": 0},
            {"change_fraction": 2},
        ]:
            with self.subTest(params=params):
                with self.assertRaises(ValueError):
                    asyncio.run(server.wait_for_change(**params))

    def test_event_filter(self):
        watcher = ui_watch.AccessibilityWatcher(
            app_filter="Chrome", event_contains="children", element_contains="dialog"
        )
        source = MagicMock()
        source.get_application.return_value.get_name.return_value = "Google Chrome"
        source.get_name.return_value = "dialog"
        source.get_role_name.return_value = "panel"
        event = MagicMock(source=source, type="object:children-changed:add")
        watcher._on_event(event)
        self.assertTrue(watcher._change.is_set())


if __name__ == "__main__":
    unittest.main()
