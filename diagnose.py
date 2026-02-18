import os

# The diagnostic block we want to inject right before the preview generation
DEBUG_BLOCK = """
        # --- 🔍 DIAGNOSTIC PROBE START ---
        st.write("---")
        st.subheader("🔍 PIPELINE INSPECTION")
        d_col1, d_col2 = st.columns(2)
        
        with d_col1:
            st.warning("📸 **Video Frame Check**")
            st.write(f"**Path in Variable:** `{bg_path}`")
            if bg_path:
                exists = os.path.exists(bg_path)
                st.write(f"**Exists on Disk:** `{exists}`")
                if exists:
                    st.write(f"**File Size:** `{os.path.getsize(bg_path)} bytes`")
                    # Check if it's a valid image header (basic check)
                    with open(bg_path, 'rb') as f:
                        header = f.read(4)
                    st.write(f"**Header Hex:** `{header.hex()}` (FFD8... is JPG)")
            else:
                st.error("❌ Variable is None/Empty")

            st.warning("📐 **Resolution Check**")
            res = st.session_state.get('mkv_resolution')
            st.write(f"**State Resolution:** `{res}`")
        
        with d_col2:
            st.warning("📝 **Subtitle Text Check**")
            st.code(f"Native (Bottom): '{native_text}'")
            st.code(f"Target (Top): '{target_text}'")
            st.code(f"Pinyin (Romanized): '{pinyin_text}'")
            
            st.warning("🎨 **Style Visibility Check**")
            st.write(f"Bottom Enabled: `{st.session_state.styles['Bottom']['enabled']}`")
            st.write(f"Top Enabled: `{st.session_state.styles['Top']['enabled']}`")
            st.write(f"Romanized Enabled: `{st.session_state.styles['Romanized']['enabled']}`")

        st.write("---")
        # --- 🔍 DIAGNOSTIC PROBE END ---
"""

print("Injecting diagnostics into srt_stitcher_app.py...")

with open("srt_stitcher_app.py", "r") as f:
    content = f.read()

# We look for the line where 'preview_html' is assigned, which is the choke point
target_str = "preview_html = generate_unified_preview("

if target_str in content and "🔍 PIPELINE INSPECTION" not in content:
    # Insert the debug block right before the function call
    new_content = content.replace(target_str, DEBUG_BLOCK + "\n        " + target_str)
    
    with open("srt_stitcher_app.py", "w") as f:
        f.write(new_content)
    print("✅ Diagnostics injected. Please restart Streamlit.")
else:
    print("⚠️ Diagnostics already present or target line not found.")