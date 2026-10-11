"""In-memory note storage."""
import itertools
import threading


class NoteStore:
    def __init__(self):
        self._notes = []
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    def add(self, text):
        with self._lock:
            note = {"id": next(self._ids), "text": text}
            self._notes.append(note)
            return note

    def all(self):
        with self._lock:
            return list(self._notes)
