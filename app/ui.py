# app/ui.py
import streamlit as st
import os
import tempfile
import tkinter as tk
from tkinter import filedialog

def browse_callback():
    """
    Callback function for the 'Browse...' button.
    Opens a native file dialog and updates st.session_state["mkv_path_input"] if a file is selected.
    """
    root = tk.Tk()
    root.withdraw()  # Hide the main window
    root.wm_attributes('-topmost', 1)  # Bring the dialog to the front
    file_path = filedialog.askopenfilename(filetypes=[("MKV files", "*.mkv")])
    root.destroy()
    if file_path:
        st.session_state["mkv_path_input"] = file_path

def render_mkv_path_input():
    """
    Renders the text input for the MKV file path and a 'Browse...' button.
    Returns the path string from session state.
    """
    cols = st.columns([3, 1])
    
    with cols[0]:
        # The value is now read directly from session_state, which is updated by the callback
        path_input = st.text_input("MKV Path", key="mkv_path_input",
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
    
    Args:
        label (str): The label for the selectbox.
        options (list): A list of dictionaries, where each dict represents an MKV track
                        like {'id': index, 'label': "Track X - [Lang]", 'path': temp_path, 'source': 'mkv'}.
        key (str): A unique key for the Streamlit components.
    
    Returns:
        str: The path to the selected subtitle file, or None if no file is selected.
    """
    display_options = {"-- Select a source --": None}
    for opt in options:
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

    return file_path

