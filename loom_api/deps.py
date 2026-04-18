"""FastAPI dependency providers."""

from .storage import FileStorage

_storage: FileStorage | None = None


def get_storage() -> FileStorage:
    global _storage
    if _storage is None:
        _storage = FileStorage()
    return _storage
