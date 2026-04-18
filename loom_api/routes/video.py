from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.models import TrackInfo, VideoMetadata
from loom_core.video.mkv_handler import get_video_metadata, scan_and_extract_tracks

from ..deps import get_storage
from ..storage import FileStorage

router = APIRouter(prefix="/video", tags=["video"])


class ScanRequest(BaseModel):
    file_id: str


class ScanResponse(BaseModel):
    metadata: VideoMetadata
    tracks: List[TrackInfo]


@router.post("/scan", response_model=ScanResponse)
def scan_video(
    req: ScanRequest,
    storage: FileStorage = Depends(get_storage),
) -> ScanResponse:
    """Scan an uploaded video for subtitle tracks + metadata.

    Text tracks are extracted to the storage tempdir and registered with
    new file IDs that the client can use in /generate/ass, /preview, etc.
    Image-based tracks (PGS, VobSub) are surfaced with ``selectable=False``
    and ``file_id=None``; they need OCR before they can be used as text.
    """
    try:
        video_path = storage.path(req.file_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown file: {req.file_id}")

    meta_dict, probe_data = get_video_metadata(str(video_path))
    metadata = VideoMetadata(
        title=meta_dict.get("title"),
        year=int(meta_dict["year"]) if meta_dict.get("year") else None,
        duration_seconds=float(meta_dict.get("duration", 0)),
        width=int(meta_dict.get("width", 1920)),
        height=int(meta_dict.get("height", 1080)),
    )

    raw_tracks = scan_and_extract_tracks(str(video_path), str(storage._base), probe_data=probe_data)

    tracks: List[TrackInfo] = []
    for t in raw_tracks:
        file_id = None
        if t.get("path"):
            file_id = storage.register_path(Path(t["path"]))
        tracks.append(
            TrackInfo(
                id=t["id"],
                sub_num=t.get("sub_num"),
                label=t["label"],
                file_id=file_id,
                lang_code=t.get("lang_code"),
                source=t.get("source", "mkv"),
                selectable=t.get("selectable", True),
                codec=t.get("codec"),
                metadata_lang=t.get("metadata_lang"),
                track_title=t.get("track_title"),
            )
        )

    return ScanResponse(metadata=metadata, tracks=tracks)
