"""Server-side file storage backing the API.

The ``Storage`` protocol is the contract every route depends on. Step 2
ships a single in-process ``LocalFileStorage`` implementation that maps
UUIDs to local tempfile paths. Step 4 (Vercel-fronted web deployment)
adds an ``S3FileStorage`` (or R2/Backblaze) implementation behind the
same protocol — routes don't change.
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from typing import Protocol


class Storage(Protocol):
    """Wire-side file handle abstraction.

    Files cross the API boundary as opaque IDs (returned by ``store_bytes``
    or ``register_path``). The route layer never exposes server filesystem
    paths to clients.
    """

    def store_bytes(self, content: bytes, suffix: str = "") -> str:
        """Persist *content* under a new ID and return the ID."""

    def register_path(self, path: Path) -> str:
        """Adopt an existing on-disk file (engine output) under a new ID."""

    def path(self, file_id: str) -> Path:
        """Resolve an ID to a server-side path. Raises ``KeyError`` if unknown."""


class LocalFileStorage:
    """In-process dict mapping UUIDs to local tempfile paths.

    Lost on restart — fine for the Tauri sidecar (single-user, dies with
    the app) and for early web work. Swap for S3/R2 at step 4.
    """

    def __init__(self, base_dir: Path | None = None) -> None:
        self._base = base_dir or Path(tempfile.gettempdir()) / "loom_api_files"
        self._base.mkdir(parents=True, exist_ok=True)
        self._index: dict[str, Path] = {}

    def store_bytes(self, content: bytes, suffix: str = "") -> str:
        file_id = uuid.uuid4().hex
        path = self._base / f"{file_id}{suffix}"
        path.write_bytes(content)
        self._index[file_id] = path
        return file_id

    def register_path(self, path: Path) -> str:
        file_id = uuid.uuid4().hex
        self._index[file_id] = path
        return file_id

    def path(self, file_id: str) -> Path:
        if file_id not in self._index:
            raise KeyError(file_id)
        return self._index[file_id]
