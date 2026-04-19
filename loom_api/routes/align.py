from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from loom_core.models import AlignResponse
from loom_core.subs.utils import compute_subtitle_offset, load_subs_cached

from ..deps import get_storage
from ..storage import Storage

router = APIRouter(tags=["align"])


class AlignRequest(BaseModel):
    """Compute the auto-alignment offset between two same-language subtitle tracks.

    Sign convention matches ``loom_core.subs.utils.compute_subtitle_offset``:
    positive offset means the reference is earlier than the target (shift
    reference-source tracks later by ``offset_seconds`` to align).
    """

    reference_file_id: str
    target_file_id: str


@router.post("/align", response_model=AlignResponse)
def compute_align(
    req: AlignRequest,
    storage: Storage = Depends(get_storage),
) -> AlignResponse:
    try:
        ref_path = storage.path(req.reference_file_id)
        tgt_path = storage.path(req.target_file_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown file: {exc.args[0]}")

    ref_subs = load_subs_cached(str(ref_path))
    tgt_subs = load_subs_cached(str(tgt_path))

    offset_seconds, warning = compute_subtitle_offset(ref_subs, tgt_subs)
    return AlignResponse(offset_seconds=offset_seconds, warning=warning)
