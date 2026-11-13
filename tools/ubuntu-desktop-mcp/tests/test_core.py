"""Fast pure-Python regression tests; no live desktop changes."""
import asyncio
import io
import json
import unittest
from unittest.mock import AsyncMock, patch

from PIL import Image as PILImage
import server


def _png(width=100, height=80):
    im = PILImage.new("RGB", (width, height), (42, 55, 77))
    buffer = io.BytesIO()
    im.save(buffer, "PNG")
    return buffer.getvalue()


class DesktopUnitTests(unittest.TestCase):
    def setUp(self):
        self.previous_size = server._screenshot_size
        server._screenshot_size = (1920, 1080)
        # Unit tests exercise tool logic without requiring the live user D-Bus.
        self._idle_patch = patch.object(server.idle_guard, "touch")
        self._idle_patch.start()
        self.addCleanup(self._idle_patch.stop)

    def tearDown(self):
        server._screenshot_size = self.previous_size

    def test_normalized_coordinates(self):
        self.assertEqual(server._position(0, 0, True), (0, 0))
        self.assertEqual(server._position(1, 1, True), (65535, 65535))
        self.assertEqual(server._position(0.5, 0.5, True), (32768, 32768))
        with self.assertRaises(ValueError):
            server._position(-0.1, 0.5, True)
        with self.assertRaises(ValueError):
            server._position(1920, 200, False)

    def test_keycodes(self):
        expected = server._keycodes("ctrl+shift+a")
        self.assertEqual(len(expected), 3)
        with self.assertRaises(ValueError):
            server._keycodes("ctrl+does-not-exist")
        with self.assertRaises(ValueError):
            server._keycodes("")

    def test_crop_and_resize_keeps_full_resolution(self):
        returned = server._pil_capture(_png(), region=(5, 8, 30, 20), scale=0.5)
        with PILImage.open(io.BytesIO(returned.data)) as im:
            self.assertEqual(im.size, (15, 10))
        self.assertEqual(server._screenshot_size, (100, 80))
        with self.assertRaises(ValueError):
            server._pil_capture(_png(), region=(90, 0, 20, 20))
        with self.assertRaises(ValueError):
            server._pil_capture(_png(), scale=2)

    def test_limits(self):
        with self.assertRaises(ValueError):
            server.double_click(50, 50, interval_ms=10)
        with self.assertRaises(ValueError):
            server.drag(1, 1, 10, 10, duration_ms=5)
        with self.assertRaises(ValueError):
            server.key_sequence([])
        with self.assertRaises(ValueError):
            asyncio.run(server.run_actions([]))

    def test_cursor_is_not_misreported_as_measured(self):
        position = server.get_cursor()
        self.assertIsNone(position["actual_position"])
        self.assertFalse(position["actual_available"])

    def test_batch_returns_text_and_png_mcp_content(self):
        with patch.object(server, "_portal_screenshot", new=AsyncMock(return_value=_png())),              patch.object(server, "_cleanup_held"):
            response = asyncio.run(server.run_actions([{"type": "wait", "ms": 1}], screenshot_after=True))
        self.assertEqual([item.type for item in response.content], ["text", "image"])
        self.assertEqual(json.loads(response.content[0].text)["completed"], 1)
        self.assertEqual(response.content[1].mimeType, "image/png")

    def test_atspi_bounds(self):
        with self.assertRaises(ValueError):
            server.a11y.tree(max_depth=0)
        with self.assertRaises(ValueError):
            server.a11y.tree(max_depth=33)


if __name__ == "__main__":
    unittest.main()
