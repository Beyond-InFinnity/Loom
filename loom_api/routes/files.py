from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..deps import get_storage
from ..storage import Storage

router = APIRouter(prefix="/files", tags=["files"])


class UploadResponse(BaseModel):
    id: str
    filename: str
    size: int


class RegisterPathRequest(BaseModel):
    path: str


@router.post("", response_model=UploadResponse)
async def upload_file(
    file: UploadFile,
    storage: Storage = Depends(get_storage),
) -> UploadResponse:
    suffix = Path(file.filename).suffix if file.filename else ""
    content = await file.read()
    file_id = storage.store_bytes(content, suffix=suffix)
    return UploadResponse(id=file_id, filename=file.filename or "", size=len(content))


@router.post("/by-path", response_model=UploadResponse)
def register_file_by_path(
    body: RegisterPathRequest,
    storage: Storage = Depends(get_storage),
) -> UploadResponse:
    # Desktop fast path: the Tauri shell hands us an absolute local path
    # and we register it with storage without copying bytes. A 94GB MKV
    # round-trip through multipart upload would be untenable; this lets
    # the engine read directly from disk. Web at step 4 keeps using the
    # multipart POST above.
    path = Path(body.path)
    if not path.is_absolute():
        raise HTTPException(status_code=400, detail="path must be absolute")
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {body.path}")
    file_id = storage.register_path(path)
    return UploadResponse(id=file_id, filename=path.name, size=path.stat().st_size)


@router.get("/{file_id}")
def download_file(
    file_id: str,
    storage: Storage = Depends(get_storage),
) -> FileResponse:
    try:
        path = storage.path(file_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown file: {exc.args[0]}")
    return FileResponse(path, filename=path.name)
