import unittest

from app.server import build_app
from tests.helpers import call


class NotesApiTests(unittest.TestCase):
    def setUp(self):
        self.app = build_app()

    def test_health(self):
        status, _, body = call(self.app, "GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True})

    def test_create_note(self):
        status, _, body = call(self.app, "POST", "/notes", {"text": "ship it"})
        self.assertEqual(status, 201)
        self.assertEqual(body["text"], "ship it")

    def test_list_notes(self):
        call(self.app, "POST", "/notes", {"text": "first"})
        status, _, body = call(self.app, "GET", "/notes")
        self.assertEqual(status, 200)
        self.assertIn("first", [n["text"] for n in body["notes"]])

    def test_create_requires_text(self):
        status, _, body = call(self.app, "POST", "/notes", {})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "text is required")

    def test_unknown_route(self):
        status, _, _ = call(self.app, "GET", "/nope")
        self.assertEqual(status, 404)
