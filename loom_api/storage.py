"""Server-side file storage backing the API.

Step 2: in-process dict mapping UUIDs to local tempfile paths. Swap for
S3/R2/disk-backed storage later without touching the routes.
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path


class FileStorage:
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
        """Register an existing on-disk file (e.g. an engine output) under a new ID."""
        file_id = uuid.uuid4().hex
        self._index[file_id] = path
        return file_id

    def path(self, file_id: str) -> Path:
        if file_id not in self._index:
            raise KeyError(file_id)
        return self._index[file_id]
