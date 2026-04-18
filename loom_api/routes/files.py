from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..deps import get_storage
from ..storage import FileStorage

router = APIRouter(prefix="/files", tags=["files"])


class UploadResponse(BaseModel):
    id: str
    filename: str
    size: int


@router.post("", response_model=UploadResponse)
async def upload_file(
    file: UploadFile,
    storage: FileStorage = Depends(get_storage),
) -> UploadResponse:
    suffix = Path(file.filename).suffix if file.filename else ""
    content = await file.read()
    file_id = storage.store_bytes(content, suffix=suffix)
    return UploadResponse(id=file_id, filename=file.filename or "", size=len(content))


@router.get("/{file_id}")
def download_file(
    file_id: str,
    storage: FileStorage = Depends(get_storage),
) -> FileResponse:
    try:
        path = storage.path(file_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown file: {exc.args[0]}")
    return FileResponse(path, filename=path.name)
