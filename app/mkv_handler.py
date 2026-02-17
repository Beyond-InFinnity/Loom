import ffmpeg
import os
import subprocess
from app import language

def scan_and_extract_tracks(mkv_path, temp_dir):
    """
    Scans an MKV file for text-based subtitle tracks, extracts them,
    detects their language, and returns a list of track information.
    """
    try:
        probe = ffmpeg.probe(mkv_path)
    except ffmpeg.Error as e:
        print(f"Error probing file: {e.stderr}")
        return []

    all_streams = probe.get('streams', [])
    
    # Debugging: Print all streams found
    print(f"--- Debugging Streams for {os.path.basename(mkv_path)} ---")
    subtitle_streams_all = []
    for stream in all_streams:
        print(f"Found Stream {stream.get('index')}: Type={stream.get('codec_type')}, Codec={stream.get('codec_name')}, Tags={stream.get('tags', 'N/A')}")
        if stream.get('codec_type') == 'subtitle':
            subtitle_streams_all.append(stream)
    print("---")

    # Filter for text-based subtitle codecs
    text_subtitle_codecs = ['srt', 'ass', 'ssa', 'subrip', 'webvtt', 'mov_text']
    subtitle_streams = [stream for stream in subtitle_streams_all if stream.get('codec_name') in text_subtitle_codecs]

    if subtitle_streams_all and not subtitle_streams:
        print("Warning: Subtitle tracks found but none matched text formats ('srt', 'ass', 'ssa', 'subrip', 'webvtt', 'mov_text').")
    
    extracted_tracks = []
    for sub_num, stream in enumerate(subtitle_streams, start=1):
        stream_index = stream['index']
        tags = stream.get('tags', {})
        metadata_lang = tags.get('language')
        track_title = tags.get('title', '')
        output_filename = os.path.join(temp_dir, f"subtitle_{sub_num}_{stream_index}.srt")

        try:
            (
                ffmpeg
                .input(mkv_path)
                .output(output_filename, map=f"0:{stream_index}")
                .run(overwrite_output=True)
            )

            detected_code = language.detect_language(
                output_filename, metadata_lang=metadata_lang
            )
            display_name = language.code_to_name(detected_code)

            # Build a descriptive label: "Subtitle 1 — Japanese"
            # Append track title from MKV metadata if present (e.g., "Cantonese", "Signs/Songs")
            label = f"Subtitle {sub_num} — {display_name}"
            if track_title:
                label += f" ({track_title})"

            extracted_tracks.append({
                'id': stream_index,
                'sub_num': sub_num,
                'label': label,
                'path': output_filename,
                'lang_code': detected_code,
                'source': 'mkv',
            })

        except ffmpeg.Error as e:
            print(f"Error extracting track {stream_index}: {e.stderr}")
        except Exception as e:
            print(f"An unexpected error occurred while processing track {stream_index}: {e}")

    return extracted_tracks

def get_duration(mkv_path):
    """
    Returns the duration of the video in whole seconds.
    Uses ffprobe's format-level duration field.
    """
    try:
        probe = ffmpeg.probe(mkv_path)
        duration_str = probe.get('format', {}).get('duration')
        if duration_str:
            return int(float(duration_str))
    except (ffmpeg.Error, ValueError, TypeError) as e:
        print(f"Error reading duration: {e}")
    return 0


def extract_screenshot(mkv_path, timestamp, temp_dir):
    """
    Extracts a single frame from the MKV file at a given timestamp and saves it as a JPG.

    Args:
        mkv_path: Path to the MKV file.
        timestamp: Timestamp in seconds to extract the frame from.
        temp_dir: Directory to write the screenshot into.
    """
    output_path = os.path.join(temp_dir, "screenshot.jpg")
    try:
        (
            ffmpeg
            .input(mkv_path, ss=timestamp)
            .output(output_path, vframes=1, q=2)
            .run(overwrite_output=True)
        )
        return output_path
    except ffmpeg.Error as e:
        print(f"Error extracting screenshot: {e.stderr}")
        return None

def merge_subs_to_mkv(input_path, sub_path, output_path):
    """
    Muxes a subtitle file into an MKV container as the default subtitle track.
    Uses subprocess directly for reliable control over ffmpeg's -map and
    -disposition flags, which ffmpeg-python handles poorly.

    No video or audio re-encoding — copies all existing streams and appends
    the new subtitle track with disposition:default.
    """
    # Figure out the index of the new subtitle stream so we can set it as default.
    # The new sub is the last subtitle stream after muxing. We need to count
    # existing subtitle streams in the original file first.
    try:
        probe = ffmpeg.probe(input_path)
        existing_sub_count = sum(
            1 for s in probe.get('streams', [])
            if s.get('codec_type') == 'subtitle'
        )
    except ffmpeg.Error:
        existing_sub_count = 0

    # The new subtitle will be at subtitle stream index = existing_sub_count
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-i", sub_path,
        "-map", "0",
        "-map", "1",
        "-c", "copy",
        "-disposition:s", "none",                          # clear all sub defaults
        f"-disposition:s:{existing_sub_count}", "default", # new track = default
        output_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Error merging subtitles: {result.stderr}")
            return None
        return output_path
    except Exception as e:
        print(f"Error merging subtitles: {e}")
        return None
