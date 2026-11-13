"""Tests for active-window detection, system snapshot and MCP idle renewal."""
import unittest
from unittest.mock import patch

import a11y
import server
import system_state
from idle import IdleGuard


class ActiveWindowTests(unittest.TestCase):
    def test_detects_chrome_only_if_atspi_marks_active(self):
        fake_windows = [
            {"name": "Inactive Slack", "app": "slack", "path": [1, 0],
             "role": "frame", "bounds": None, "active": False, "focused": False},
            {"name": "Pointer Lab - Google Chrome", "app": "Google Chrome", "path": [2, 0],
             "role": "frame", "bounds": {"x": 0, "y": 0, "width": 1920, "height": 1080},
             "active": True, "focused": False},
        ]
        with patch.object(a11y, "windows", return_value=fake_windows):
            found = a11y.active_window()
        self.assertTrue(found["found"])
        self.assertTrue(found["is_browser"])
        self.assertTrue(found["is_chrome"])
        self.assertEqual(found["title"], "Pointer Lab - Google Chrome")
        self.assertEqual(found["path"], [2, 0])

    def test_no_window_fails_gracefully(self):
        with patch.object(a11y, "windows", return_value=[]):
            result = a11y.active_window()
        self.assertFalse(result["found"])
        self.assertIn("reason", result)


class StateTests(unittest.TestCase):
    def test_cpu_mem_and_time(self):
        fake_idle = {"active": True, "remaining_seconds": 119.0}
        with patch.object(system_state.a11y, "active_window", return_value={"found": False}),              patch.object(system_state.idle_guard, "status", return_value=fake_idle):
            result = system_state.snapshot()
        self.assertIn("local_time", result)
        self.assertIn("keyboard", result)
        self.assertIn("usage_percent", result["cpu"])
        self.assertIn("available_gib", result["memory"])
        self.assertEqual(result["idle_protection"], fake_idle)

    def test_keyboard_is_not_claimed_verified(self):
        state = system_state._keyboard_layout()
        self.assertFalse(state["selected_verified"])

    def test_activity_wrapper_rearms_before_and_after_tool(self):
        tool = next(t for t in server.mcp._tool_manager.list_tools() if t.name == "get_active_window")
        with patch.object(server.idle_guard, "touch") as touch,              patch.object(server.a11y, "active_window", return_value={"found": True}):
            self.assertEqual(tool.fn(), {"found": True})
        self.assertEqual(touch.call_count, 2)

    def test_lease_duration_constraints(self):
        with self.assertRaises(ValueError):
            IdleGuard(ttl_seconds=1)
        with self.assertRaises(ValueError):
            IdleGuard(ttl_seconds=1801)


if __name__ == "__main__":
    unittest.main()
