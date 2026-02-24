# app/ui.py
import streamlit as st
import os
import shutil
import subprocess
import tempfile


def _native_file_dialog(filetypes: list[tuple[str, str]]) -> str | None:
    """Open the desktop's native file picker, falling back to tkinter.

    Tries zenity (GNOME/GTK) first, then kdialog (KDE), then tkinter.

    Parameters
    ----------
    filetypes : list[tuple[str, str]]
        Filter list in tkinter format, e.g.
        ``[("Video files", "*.mkv *.mp4"), ("All files", "*.*")]``.

    Returns
    -------
    str | None
        Selected file path, or ``None`` if the user cancelled.
    """
    # Build extension list from the first non-"all" filter entry.
    extensions: list[str] = []
    filter_label = "Files"
    for label, pattern in filetypes:
        if pattern.strip() == "*.*":
            continue
        filter_label = label
        for token in pattern.split():
            ext = token.lstrip("*.")
            if ext:
                extensions.append(ext)
        break

    # --- zenity (GNOME / GTK) -------------------------------------------
    if shutil.which("zenity"):
        ext_pattern = " ".join(f"*.{e}" for e in extensions) if extensions else "*"
        cmd = [
            "zenity", "--file-selection",
            f"--file-filter={filter_label} | {ext_pattern}",
            "--file-filter=All files | *",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        return None

    # --- kdialog (KDE) ---------------------------------------------------
    if shutil.which("kdialog"):
        ext_pattern = " ".join(f"*.{e}" for e in extensions) if extensions else "*"
        filter_str = f"{ext_pattern} | {filter_label}"
        cmd = ["kdialog", "--getopenfilename", ".", filter_str]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        return None

    # --- tkinter fallback ------------------------------------------------
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.wm_attributes("-topmost", 1)
    path = filedialog.askopenfilename(filetypes=filetypes)
    root.destroy()
    return path or None


def browse_callback():
    """
    Callback function for the 'Browse...' button.
    Opens a native file dialog and updates st.session_state["mkv_path_input"] if a file is selected.
    """
    file_path = _native_file_dialog([
        ("Video files", "*.mkv *.mp4 *.avi *.mov *.webm *.ts *.m2ts"),
        ("All files", "*.*"),
    ])
    if file_path:
        st.session_state["mkv_path_input"] = file_path

def render_mkv_path_input():
    """
    Renders the text input for the video file path and a 'Browse...' button.
    Returns the path string from session state.
    """
    cols = st.columns([3, 1])

    with cols[0]:
        # The value is now read directly from session_state, which is updated by the callback
        path_input = st.text_input("Video file path", key="mkv_path_input",
                                   value=st.session_state.get("mkv_path_input", ""))
    
    with cols[1]:
        # Add some vertical space to align the button with the text input
        st.write("<br>", unsafe_allow_html=True)
        st.button("Browse...", on_click=browse_callback)

    # No need for st.rerun() here, as the button's on_click callback directly modifies
    # session state, and Streamlit will rerun automatically on state change or widget interaction.
    return st.session_state.get("mkv_path_input")

def render_hybrid_selector(label, options, key):
    """
    Renders a selectbox with provided options (MKV tracks) and an option to upload a custom file.
    Always returns a file path string (saving uploads to temp if needed).

    Tracks with ``selectable=False`` (e.g. PGS image-based subtitles) are excluded
    from the dropdown and shown as informational captions below it.

    Args:
        label (str): The label for the selectbox.
        options (list): A list of dictionaries, where each dict represents an MKV track
                        like {'id': index, 'label': "Track X - [Lang]", 'path': temp_path,
                              'source': 'mkv', 'selectable': True}.
        key (str): A unique key for the Streamlit components.

    Returns:
        str: The path to the selected subtitle file, or None if no file is selected.
    """
    selectable = [opt for opt in options if opt.get('selectable', True)]
    non_selectable = [opt for opt in options if not opt.get('selectable', True)]

    display_options = {"-- Select a source --": None}
    for opt in selectable:
        display_options[opt['label']] = opt['path']
    display_options["📂 Upload Custom File..."] = "upload"

    selection_label = st.selectbox(
        label,
        list(display_options.keys()),
        key=f"{key}_selector"
    )

    selected_value = display_options[selection_label]

    file_path = None

    if selected_value == "upload":
        uploaded_file = st.file_uploader(
            "Upload a .srt or .ass file",
            type=["srt", "ass", "ssa"],
            key=f"{key}_uploader"
        )
        if uploaded_file:
            # Save the uploaded file to the session's temp directory
            temp_dir = st.session_state.get('temp_dir')
            if not temp_dir:
                st.error("Temporary directory not initialized.")
                return None

            # Create a unique filename to avoid conflicts
            unique_filename = f"{key}_{uploaded_file.name}"
            save_path = os.path.join(temp_dir, unique_filename)

            with open(save_path, "wb") as f:
                f.write(uploaded_file.getvalue())
            file_path = save_path
    else:
        file_path = selected_value

    # Show non-selectable tracks as informational captions.
    # PGS tracks with OCR capability are rendered by render_ocr_buttons() instead.
    _ocr_codecs = {'hdmv_pgs_subtitle'}
    for opt in non_selectable:
        if opt.get('codec') not in _ocr_codecs:
            st.caption(opt['label'])

    return file_path


def render_path_input(label, state_key, default_value="", filetypes=None):
    """Render a text input with a Browse button for selecting a file path.

    Parameters
    ----------
    label : str
        Label for the text input widget.
    state_key : str
        Session state key for the path value.
    default_value : str
        Initial value when the key is not yet in session state.
    filetypes : list[tuple] | None
        File type filter for the native dialog.  Defaults to video files.

    Returns
    -------
    str
        The current path string (may be empty).
    """
    if filetypes is None:
        filetypes = [("Video files", "*.mkv *.mp4 *.avi *.mov *.webm *.ts *.m2ts"), ("All files", "*.*")]

    def _browse():
        path = _native_file_dialog(filetypes)
        if path:
            st.session_state[state_key] = path

    cols = st.columns([3, 1])
    with cols[0]:
        st.text_input(
            label, key=state_key,
            value=st.session_state.get(state_key, default_value),
        )
    with cols[1]:
        st.write("<br>", unsafe_allow_html=True)
        st.button("Browse...", on_click=_browse, key=f"{state_key}_browse")
    return st.session_state.get(state_key, default_value)


def render_ocr_buttons(tracks, key):
    """Show OCR buttons for PGS tracks.

    Parameters
    ----------
    tracks : list[dict]
        Full track list (selectable + non-selectable).
    key : str
        Unique key prefix for Streamlit widget deduplication.

    Returns
    -------
    dict | None
        The track dict if an OCR button was clicked, else None.
    """
    _ocr_codecs = {'hdmv_pgs_subtitle'}
    for track in tracks:
        if track.get('selectable') or track.get('codec') not in _ocr_codecs:
            continue
        btn_key = f"ocr_btn_{key}_{track['id']}"
        col1, col2 = st.columns([3, 1])
        with col1:
            st.caption(track['label'])
        with col2:
            if st.button("Extract Text (OCR)", key=btn_key):
                return track
    return None

