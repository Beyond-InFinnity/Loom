import os

# 1. Create the directory if it doesn't exist
os.makedirs("drag_preview_component", exist_ok=True)

# 2. CREATE THE MISSING JAVASCRIPT FILE (This was the yellow box error)
lib_js = """
function sendMessageToStreamlitClient(type, data) {
    const outData = Object.assign({isStreamlitMessage: true, type: type}, data);
    window.parent.postMessage(outData, "*");
}

const Streamlit = {
    setComponentReady: function() { sendMessageToStreamlitClient("streamlit:componentReady", {apiVersion: 1}); },
    setFrameHeight: function(height) { sendMessageToStreamlitClient("streamlit:setFrameHeight", {height: height}); },
    setComponentValue: function(value) { sendMessageToStreamlitClient("streamlit:setComponentValue", {value: value}); },
    events: {
        addEventListener: function(type, callback) {
            window.addEventListener("message", function(event) {
                if (event.data.type === type) {
                    callback(event.data);
                }
            });
        }
    }
};
"""
with open("drag_preview_component/streamlit-component-lib.js", "w") as f:
    f.write(lib_js)

# 3. CREATE THE FLUID/RESPONSIVE INDEX.HTML (Fixes the 4K width issue)
index_html = """
<!DOCTYPE html>
<html>
<head>
    <style>
        body { margin: 0; background-color: #000; overflow: hidden; display: flex; align-items: center; justify-content: center; height: 100vh; }
        #container {
            width: 100%;
            aspect-ratio: 16 / 9;
            background: #111;
            position: relative;
            border: 1px solid #333;
            overflow: hidden;
        }
        #text-element {
            position: absolute;
            cursor: grab;
            user-select: none;
            white-space: nowrap;
            text-align: center;
            color: white;
            font-family: Arial, sans-serif;
            font-weight: bold;
            text-shadow: 2px 2px 0 #000;
        }
        #text-element:active { cursor: grabbing; }
        .grid-x { position: absolute; top: 50%; left: 0; right: 0; border-top: 1px dashed #555; pointer-events: none; opacity: 0; }
        .grid-y { position: absolute; left: 50%; top: 0; bottom: 0; border-left: 1px dashed #555; pointer-events: none; opacity: 0; }
        .dragging .grid-x, .dragging .grid-y { opacity: 1; }
    </style>
</head>
<body>
    <div id="container">
        <div class="grid-x"></div>
        <div class="grid-y"></div>
        <div id="text-element">DRAG ME</div>
    </div>
    <script src="./streamlit-component-lib.js"></script>
    <script>
        const container = document.getElementById("container");
        const textEl = document.getElementById("text-element");
        let isDragging = false;

        Streamlit.events.addEventListener("streamlit:render", function(event) {
            const args = event.args;
            textEl.innerText = args.text || "Sample Text";
            textEl.style.fontSize = (args.styles.fontsize || 24) + "px";
            textEl.style.color = args.styles.primarycolor ? args.styles.primarycolor.replace("&H00", "#") : "white";
            
            // Initial positioning logic
            if (!isDragging) {
                const cw = container.clientWidth;
                const ch = container.clientHeight;
                const x = (args.initial_x !== null) ? args.initial_x * cw : (cw / 2) - (textEl.clientWidth / 2);
                const y = (args.initial_y !== null) ? args.initial_y * ch : (ch - 50);
                textEl.style.left = x + "px";
                textEl.style.top = y + "px";
            }
            Streamlit.setFrameHeight(document.body.scrollHeight);
        });

        // Simple Drag Logic
        textEl.addEventListener("mousedown", startDrag);
        function startDrag(e) {
            isDragging = true;
            container.classList.add("dragging");
            let startX = e.clientX - textEl.offsetLeft;
            let startY = e.clientY - textEl.offsetTop;

            function moveDrag(e) {
                if (!isDragging) return;
                let newX = e.clientX - startX;
                let newY = e.clientY - startY;
                textEl.style.left = newX + "px";
                textEl.style.top = newY + "px";
            }

            function stopDrag() {
                isDragging = false;
                container.classList.remove("dragging");
                window.removeEventListener("mousemove", moveDrag);
                window.removeEventListener("mouseup", stopDrag);
                
                // Send percentage coordinates back to Python
                const normX = parseFloat(textEl.style.left) / container.clientWidth;
                const normY = parseFloat(textEl.style.top) / container.clientHeight;
                Streamlit.setComponentValue({x: normX, y: normY});
            }
            window.addEventListener("mousemove", moveDrag);
            window.addEventListener("mouseup", stopDrag);
        }
        Streamlit.setComponentReady();
    </script>
</body>
</html>
"""
with open("drag_preview_component/index.html", "w") as f:
    f.write(index_html)

print("✅ FIXED! You can now restart Streamlit.")
