import ffmpeg
import os
import subprocess
from app import language


def _probe(file_path):
    """Run ffprobe with optimised analysis limits.

    Passes ``-probesize 100M -analyzeduration 100M`` so ffprobe does not
    spend excessive time analysing image-based streams (PGS, VobSub) in
    large containers.  Without these flags a 94 GB Criterion 4K disc can
    stall for tens of seconds while ffprobe tries to characterise every
    PGS stream.

    Returns the parsed JSON dict (same shape as ``ffmpeg.probe()``).
    """
    return ffmpeg.probe(file_path, probesize='100M', analyzeduration='100M')


# Codec → output file extension mapping.
# ASS/SSA tracks are preserved in their native format so override tags,
# style sections, and existing furigana annotations are not lost.
_CODEC_EXT = {
    'subrip':   'srt',
    'srt':      'srt',
    'ass':      'ass',
    'ssa':      'ass',
    'webvtt':   'vtt',
    'mov_text': 'srt',
}
_TEXT_CODECS = set(_CODEC_EXT.keys())

# Image-based codecs cannot be text-extracted.  Surface them in the track
# list with a clear label so users understand why they are unavailable.
_IMAGE_CODECS = {
    'hdmv_pgs_subtitle': 'PGS',
    'dvd_subtitle':      'VobSub',
    'dvb_subtitle':      'DVB',
    'xsub':              'XSUB',
}


def scan_and_extract_tracks(mkv_path, temp_dir, probe_data=None):
    """Scan an MKV file for subtitle tracks, extract text tracks, detect language.

    Parameters
    ----------
    mkv_path : str
        Absolute path to the MKV file.
    temp_dir : str
        Directory for extracted subtitle files.
    probe_data : dict | None
        Pre-computed ffprobe result from ``get_video_metadata()``.  When
        provided the probe step is skipped entirely — the 94 GB file is
        probed once, not twice.

    Returns
    -------
    list[dict]
        One dict per subtitle stream.  Text-based tracks have
        ``selectable=True`` and a valid ``path``; image-based tracks have
        ``selectable=False`` and ``path=None``.
    """
    if probe_data is None:
        try:
            probe_data = _probe(mkv_path)
        except ffmpeg.Error as e:
            print(f"Error probing file: {e.stderr}")
            return []

    all_streams = probe_data.get('streams', [])

    print(f"--- Streams for {os.path.basename(mkv_path)} ---")
    subtitle_streams = []
    for stream in all_streams:
        if stream.get('codec_type') == 'subtitle':
            subtitle_streams.append(stream)
            print(f"  Sub stream {stream.get('index')}: codec={stream.get('codec_name')}, "
                  f"tags={stream.get('tags', {})}")
    print(f"--- {len(subtitle_streams)} subtitle stream(s) found ---")

    # ── Phase 1: classify streams ──────────────────────────────────────
    # Build the extraction plan (text tracks only).  PGS / image tracks
    # are added to the result list immediately with selectable=False and
    # are NEVER passed to ffmpeg for extraction.
    text_tracks = []   # (sub_num, stream_index, ext, metadata_lang, track_title, output_path)
    result = []
    sub_num = 0

    for stream in subtitle_streams:
        codec = stream.get('codec_name', '')
        stream_index = stream['index']
        tags = stream.get('tags', {})
        track_title = tags.get('title', '')
        metadata_lang = tags.get('language')

        if codec in _IMAGE_CODECS:
            fmt_name = _IMAGE_CODECS[codec]
            # Resolve display name from metadata language tag.
            lang_display = language.code_to_name(metadata_lang) if metadata_lang else None
            label_parts = [f"Stream {stream_index}"]
            if lang_display:
                label_parts.append(f"— {lang_display}")
            label_parts.append(f"({fmt_name}, image-based)")
            if track_title:
                label_parts.append(f"[{track_title}]")
            result.append({
                'id': stream_index,
                'sub_num': None,
                'label': ' '.join(label_parts),
                'path': None,
                'lang_code': None,
                'source': 'mkv',
                'selectable': False,
                'codec': codec,
                'metadata_lang': metadata_lang,
                'track_title': track_title,
            })
            continue

        if codec not in _TEXT_CODECS:
            print(f"  Skipping stream {stream_index}: unrecognised codec '{codec}'")
            continue

        sub_num += 1
        ext = _CODEC_EXT[codec]
        output_path = os.path.join(temp_dir, f"subtitle_{sub_num}_{stream_index}.{ext}")
        text_tracks.append((sub_num, stream_index, ext, metadata_lang, track_title, output_path))

    # ── Phase 2: single-pass extraction of ALL text tracks ─────────────
    # One ffmpeg invocation demuxes the container once.  Compared to the
    # previous approach (one invocation per track), this reduces I/O from
    # N full file opens to 1 — critical for large containers (94 GB+).
    if text_tracks:
        cmd = ["ffmpeg", "-y", "-i", mkv_path]
        for _sn, sidx, _ext, _ml, _tt, opath in text_tracks:
            cmd += ["-map", f"0:{sidx}", "-c", "copy", opath]

        print(f"  Extracting {len(text_tracks)} text track(s) in one pass...")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                print(f"  ffmpeg extraction error: {proc.stderr[-500:]}")
        except Exception as e:
            print(f"  ffmpeg extraction exception: {e}")

    # ── Phase 3: language detection on extracted files ──────────────────
    for sub_num_i, stream_index, ext, metadata_lang, track_title, output_path in text_tracks:
        if not os.path.exists(output_path):
            print(f"  Warning: expected output missing for stream {stream_index}: {output_path}")
            continue

        detected_code = language.detect_language(
            output_path, metadata_lang=metadata_lang,
            track_title=track_title,
        )
        display_name = language.code_to_name(detected_code)

        label = f"Subtitle {sub_num_i} — {display_name}"
        if track_title:
            label += f" ({track_title})"

        result.append({
            'id': stream_index,
            'sub_num': sub_num_i,
            'label': label,
            'path': output_path,
            'lang_code': detected_code,
            'source': 'mkv',
            'selectable': True,
        })

    return result


def extract_pgs_stream(mkv_path, stream_index, output_dir):
    """Extract a PGS stream from MKV as a .sup file via ffmpeg codec copy.

    Parameters
    ----------
    mkv_path : str
        Path to the MKV file.
    stream_index : int
        ffmpeg stream index of the PGS track.
    output_dir : str
        Directory for the extracted .sup file.

    Returns
    -------
    str
        Absolute path to the extracted .sup file.

    Raises
    ------
    RuntimeError
        If ffmpeg extraction fails.
    """
    output_path = os.path.join(output_dir, f"stream_{stream_index}.sup")
    cmd = [
        "ffmpeg", "-y",
        "-i", mkv_path,
        "-map", f"0:{stream_index}",
        "-c", "copy",
        output_path,
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed to extract PGS stream {stream_index}: "
                f"{proc.stderr[-500:]}"
            )
    except FileNotFoundError:
        raise RuntimeError("ffmpeg is not installed or not in PATH.")

    if not os.path.exists(output_path):
        raise RuntimeError(
            f"ffmpeg did not produce output file for stream {stream_index}."
        )

    return output_path


def get_video_metadata(mkv_path):
    """Return video metadata and the raw ffprobe result for reuse.

    Returns
    -------
    (dict, dict)
        Tuple of (metadata_dict, probe_data).  metadata_dict has keys
        ``duration`` (int seconds), ``width``, ``height``, ``title``
        (str | None), ``year`` (str | None).  probe_data is the raw
        ffprobe JSON for passing to ``scan_and_extract_tracks()``.
    """
    defaults = {"duration": 0, "width": 1920, "height": 1080,
                "title": None, "year": None}
    try:
        probe_data = _probe(mkv_path)

        fmt_tags = probe_data.get('format', {}).get('tags', {})
        duration_str = probe_data.get('format', {}).get('duration')
        duration = int(float(duration_str)) if duration_str else 0

        video_stream = next(
            (s for s in probe_data.get('streams', []) if s.get('codec_type') == 'video'),
            None,
        )
        width = int(video_stream['width']) if video_stream else 1920
        height = int(video_stream['height']) if video_stream else 1080

        # Title: from format tags, falling back to filename
        title = fmt_tags.get('title') or fmt_tags.get('TITLE')
        if not title:
            title = os.path.splitext(os.path.basename(mkv_path))[0]

        # Year: from date or year tag
        year = fmt_tags.get('year') or fmt_tags.get('YEAR')
        if not year:
            date_str = fmt_tags.get('date') or fmt_tags.get('DATE') or ''
            if date_str and len(date_str) >= 4:
                year = date_str[:4]

        return {
            "duration": duration, "width": width, "height": height,
            "title": title, "year": year,
        }, probe_data

    except (ffmpeg.Error, ValueError, TypeError) as e:
        print(f"Error reading metadata: {e}")
        return defaults, None


def extract_screenshot(mkv_path, timestamp, temp_dir):
    """Extract a single frame from the MKV file at *timestamp* seconds."""
    output_path = os.path.join(temp_dir, "screenshot.jpg")
    try:
        (
            ffmpeg
            .input(mkv_path, ss=timestamp)
            .output(output_path, vframes=1, q=2, update=1)
            .run(overwrite_output=True)
        )
        return output_path
    except ffmpeg.Error as e:
        print(f"Error extracting screenshot: {e.stderr}")
        return None


def _build_track_title(target_lang_name, native_lang_name,
                       annotation_name=None, romanization_name=None,
                       is_pgs=False):
    """Build a descriptive track title for MKV subtitle metadata.

    Pattern: {TargetLang} + {NativeLang} [{Annotation} / {Romanization}] [PGS] (SRTStitcher)

    Examples:
        "Japanese + English [Furigana / Hepburn] (SRTStitcher)"
        "Japanese + English [Furigana / Hepburn] PGS (SRTStitcher)"
    """
    parts = []
    if target_lang_name:
        parts.append(target_lang_name)
    if native_lang_name:
        parts.append(f"+ {native_lang_name}")

    extras = []
    if annotation_name:
        extras.append(annotation_name)
    if romanization_name:
        extras.append(romanization_name)
    if extras:
        parts.append(f"[{' / '.join(extras)}]")

    if is_pgs:
        parts.append("PGS")

    parts.append("(SRTStitcher)")
    return ' '.join(parts)


def merge_subs_to_mkv(input_path, output_path,
                      ass_path=None, sup_path=None,
                      target_lang_code=None,
                      track_title=None, pgs_track_title=None,
                      keep_existing_subs=True,
                      keep_attachments=True):
    """Mux subtitle file(s) into an MKV as the default subtitle track.

    No video or audio re-encoding — copies all existing streams and
    appends the new subtitle track(s).

    Parameters
    ----------
    input_path : str
        Source MKV/video file.
    output_path : str
        Destination MKV file.
    ass_path : str | None
        Path to the .ass subtitle file.
    sup_path : str | None
        Path to the PGS .sup file.
    target_lang_code : str | None
        BCP-47 language tag for track metadata (e.g. "ja", "zh").
    track_title : str | None
        Descriptive title for the .ass track.
    pgs_track_title : str | None
        Descriptive title for the PGS track.
    keep_existing_subs : bool
        If True (default), preserve the source file's subtitle tracks.
        If False, strip them — only the new .ass / .sup tracks are included.
    keep_attachments : bool
        If True (default), preserve font attachments from the source.
        If False, strip them (smaller output, but embedded fonts are lost).
    """
    if not ass_path and not sup_path:
        print("No subtitle files to mux.")
        return None

    existing_sub_count = 0
    if keep_existing_subs:
        try:
            probe_data = _probe(input_path)
            existing_sub_count = sum(
                1 for s in probe_data.get('streams', [])
                if s.get('codec_type') == 'subtitle'
            )
        except ffmpeg.Error:
            pass

    cmd = ["ffmpeg", "-y", "-i", input_path]
    input_idx = 1  # next -i index
    ass_sub_idx = None
    sup_sub_idx = None

    if ass_path:
        cmd += ["-i", ass_path]
        input_idx += 1

    if sup_path:
        cmd += ["-i", sup_path]
        input_idx += 1

    # Map source streams by type — NOT "-map 0" which pulls everything
    # as a blob and causes stream-index confusion when TTF attachments
    # are interleaved with subtitle streams.  Explicit type mapping
    # ensures predictable output ordering:
    #   video → audio → [existing subs] → new subs → [attachments]
    maps = ["-map", "0:v", "-map", "0:a"]
    if keep_existing_subs:
        maps += ["-map", "0:s?"]  # existing subs (? = don't error if none)

    # Map new subtitle inputs — placed right after existing subs
    next_input = 1
    if ass_path:
        maps += ["-map", str(next_input)]
        ass_sub_idx = existing_sub_count  # 0 when stripping existing subs
        next_input += 1
    if sup_path:
        maps += ["-map", str(next_input)]
        sup_sub_idx = existing_sub_count + (1 if ass_path else 0)
        next_input += 1

    # Preserve font attachments last (? = skip if none exist)
    if keep_attachments:
        maps += ["-map", "0:t?"]

    cmd += maps + ["-c", "copy"]

    # Set disposition: clear all subtitle dispositions, then mark our track
    # as default.  Use "0" (not "none") for cross-version ffmpeg compat.
    cmd += ["-disposition:s", "0"]
    default_idx = ass_sub_idx if ass_sub_idx is not None else sup_sub_idx
    if default_idx is not None:
        cmd += [f"-disposition:s:{default_idx}", "default"]

    # Metadata for .ass track
    if ass_sub_idx is not None:
        if target_lang_code:
            cmd += [f"-metadata:s:s:{ass_sub_idx}", f"language={target_lang_code}"]
        if track_title:
            cmd += [f"-metadata:s:s:{ass_sub_idx}", f"title={track_title}"]

    # Metadata for PGS track
    if sup_sub_idx is not None:
        if target_lang_code:
            cmd += [f"-metadata:s:s:{sup_sub_idx}", f"language={target_lang_code}"]
        if pgs_track_title:
            cmd += [f"-metadata:s:s:{sup_sub_idx}", f"title={pgs_track_title}"]

    cmd.append(output_path)

    # Log the full command for debugging mux issues
    print(f"[merge_subs_to_mkv] ffmpeg command:")
    print(f"  {' '.join(cmd)}")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Error merging subtitles: {result.stderr[-1000:]}")
            return None
        return output_path
    except Exception as e:
        print(f"Error merging subtitles: {e}")
        return None
