#!/usr/bin/env bash
# Serve the spike directory over HTTP so the browser can fetch frame.html
# + fonts under same origin.  Without this, drawImage(svg-with-html) ->
# canvas would taint the canvas and getImageData would throw.
cd "$(dirname "$0")"
exec python -m http.server 8001
