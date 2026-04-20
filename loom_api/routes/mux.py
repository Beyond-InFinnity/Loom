"""Mux route: merge generated .ass / .sup into a source video as MKV.

Accepts file_ids (video + optional ass + optional sup) and a *user-picked*
absolute output path. The sidecar writes ffmpeg's output directly to that
path — no double-transfer of a multi-GB remux through HTTP.

This is safe for the Tauri sidecar (single-user, localhost-only). If this
route ever ships behind a shared web service, ``output_path`` must be
replaced by a storage-backed ``result_file_id`` round-trip.
"""
import asyncio
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.language import code_to_name
from loom_core.models import JobAccepted, JobStatus, PhoneticSystem
from loom_core.styles import get_lang_config
from loom_core.video.mkv_handler import _build_track_title, merge_subs_to_mkv

from ..deps import get_jobs, get_storage
from ..jobs import JobManager
from ..storage import Storage

router = APIRouter(tags=["mux"])


class MuxRequest(BaseModel):
    video_file_id: str
    ass_file_id: Optional[str] = None
    sup_file_id: Optional[str] = None
    output_path: str

    target_lang_code: Optional[str] = None
    native_lang_code: Optional[str] = None
    phonetic_system: Optional[PhoneticSystem] = None
    annotation_enabled: bool = False

    keep_existing_subs: bool = True
    keep_attachments: bool = True
    default_audio_index: Optional[int] = None


@router.post("/mux", response_model=JobAccepted)
async def start_mux(
    req: MuxRequest,
    storage: Storage = Depends(get_storage),
    jobs: JobManager = Depends(get_jobs),
) -> JobAccepted:
    if not req.ass_file_id and not req.sup_file_id:
        raise HTTPException(status_code=400, detail="Need at least one of ass_file_id or sup_file_id")

    output_path = Path(req.output_path)
    if not output_path.is_absolute():
        raise HTTPException(status_code=400, detail="output_path must be absolute")
    if not output_path.parent.exists():
        raise HTTPException(status_code=400, detail=f"output directory does not exist: {output_path.parent}")
    if output_path.suffix.lower() != ".mkv":
        output_path = output_path.with_suffix(".mkv")

    try:
        video_path = storage.path(req.video_file_id)
        ass_path = storage.path(req.ass_file_id) if req.ass_file_id else None
        sup_path = storage.path(req.sup_file_id) if req.sup_file_id else None
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown file: {exc.args[0]}")

    # Build track titles server-side so the client doesn't have to replicate
    # naming conventions. Names are derived from lang_code + phonetic_system;
    # annotation_name is included only when the caller had the Annotation
    # layer enabled (a generation-time decision we can't recover from file_ids).
    target_name = code_to_name(req.target_lang_code) if req.target_lang_code else None
    native_name = code_to_name(req.native_lang_code) if req.native_lang_code else None

    annotation_name: Optional[str] = None
    romanization_name: Optional[str] = None
    if req.target_lang_code:
        lang_cfg = get_lang_config(req.target_lang_code, phonetic_system=req.phonetic_system)
        if req.annotation_enabled and lang_cfg.get("annotation_func") is not None:
            annotation_name = lang_cfg.get("annotation_system_name")
        if lang_cfg.get("romanize_func") is not None:
            romanization_name = lang_cfg.get("romanization_name")

    ass_track_title = _build_track_title(
        target_name, native_name,
        annotation_name=annotation_name,
        romanization_name=romanization_name,
    ) if ass_path else None
    pgs_track_title = _build_track_title(
        target_name, native_name,
        annotation_name=annotation_name,
        romanization_name=romanization_name,
        is_pgs=True,
    ) if sup_path else None

    async def worker(status: JobStatus) -> None:
        status.phase = "muxing"
        result = await asyncio.to_thread(
            merge_subs_to_mkv,
            str(video_path),
            str(output_path),
            ass_path=str(ass_path) if ass_path else None,
            sup_path=str(sup_path) if sup_path else None,
            target_lang_code=req.target_lang_code,
            track_title=ass_track_title,
            pgs_track_title=pgs_track_title,
            keep_existing_subs=req.keep_existing_subs,
            keep_attachments=req.keep_attachments,
            default_audio_index=req.default_audio_index,
        )
        if result is None:
            raise RuntimeError("merge_subs_to_mkv returned None (see sidecar logs for ffmpeg stderr)")
        # Register the output so clients can GET /files/{id} if they want to
        # open it later — even though the user already has the path.
        status.result_file_id = storage.register_path(output_path)

    return jobs.submit("mux", worker)
