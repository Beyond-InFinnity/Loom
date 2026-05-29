// Loom — Netflix recon capture kit.
//
// Paste this whole file into the DevTools Console on a Netflix tab. It runs in
// the page's MAIN world (where window.netflix lives), installs the JSON.parse /
// JSON.stringify hooks that are the ONLY way to read Netflix's MSL-encrypted
// manifest, and exposes helpers under window.__loomNflx to dump tracks, probe
// the player API + DOM anchors, and fetch a real subtitle sample.
//
// ── TIMING MATTERS ──────────────────────────────────────────────────────────
// The hooks must be installed BEFORE the player fetches the manifest. Reliable
// flow:
//   1. Open a Netflix title page (or the browse page) — do NOT start playing.
//   2. Open DevTools Console, paste this file, hit Enter.
//   3. Click Play. The manifest fires on playback start; you'll see a green
//      "[loom-nflx] manifest captured" line + a table of subtitle tracks.
//   If you're ALREADY watching: paste this, then change the subtitle language
//   once (Audio & Subtitles menu) — Netflix re-fetches the manifest and the
//   hook catches it. (A full page reload wipes these console-injected hooks.)
//
// Then, in the console:
//   __loomNflx.dumpTracks()              list captured subtitle tracks
//   __loomNflx.dom()                     check overlay-anchor selectors exist
//   __loomNflx.time()                    player + <video> currentTime/duration
//   await __loomNflx.fetchSample('ja')   fetch + download a sample .vtt
//
// Save the downloaded .vtt over spike/netflix/sample-subs-ja.vtt and re-run
// `node spike/netflix/parse-test.mjs` to validate the parser on real data.

(() => {
  const NS = (window.__loomNflx = window.__loomNflx || {});
  if (NS.__installed) {
    console.warn("[loom-nflx] already installed; helpers are on window.__loomNflx");
    return;
  }
  NS.__installed = true;
  NS.manifests = [];
  NS.tracks = [];

  const WEBVTT_PROFILE = "webvtt-lssdh-ios8";
  const tag = "color:#fff;background:#b1060f;padding:1px 6px;border-radius:3px";
  const ok = "color:#46d369";

  // ── 1. JSON.stringify hook: force WebVTT into the outgoing manifest request.
  // Netflix's default request doesn't ask for WebVTT; we find the `profiles`
  // array (by shape, since Netflix renames keys) and prepend our profile.
  const origStringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) {
    try {
      const profs = findProfilesArray(value);
      if (profs && !profs.includes(WEBVTT_PROFILE)) {
        profs.unshift(WEBVTT_PROFILE);
        if (!NS.__injected) {
          NS.__injected = true;
          console.log("[loom-nflx] injected %s into a manifest request", WEBVTT_PROFILE);
        }
      }
    } catch {
      /* never break the page's stringify */
    }
    return origStringify.call(this, value, ...rest);
  };

  // ── 2. JSON.parse hook: catch the decrypted manifest the player deserializes.
  const origParse = JSON.parse;
  JSON.parse = function (text, ...rest) {
    const val = origParse.call(this, text, ...rest);
    try {
      const r = val && val.result && val.result.timedtexttracks ? val.result : val;
      if (r && r.timedtexttracks && r.movieId) captureManifest(r);
    } catch {
      /* ignore */
    }
    return val;
  };

  function findProfilesArray(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 8) return null;
    if (
      Array.isArray(obj.profiles) &&
      obj.profiles.some((p) => typeof p === "string")
    ) {
      return obj.profiles;
    }
    for (const k of Object.keys(obj)) {
      const found = findProfilesArray(obj[k], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function captureManifest(result) {
    NS.manifests.push(result);
    NS.tracks = (result.timedtexttracks || []).map((t) => ({
      language: t.language,
      label: t.languageDescription,
      type: t.rawTrackType, // 'subtitles' | 'closedcaptions'
      forced: !!t.isForcedNarrative,
      none: !!t.isNoneTrack,
      trackId: t.new_track_id || t.trackId,
      profiles: Object.keys(t.ttDownloadables || {}),
      hasWebVtt: !!(t.ttDownloadables && t.ttDownloadables[WEBVTT_PROFILE]),
      _raw: t,
    }));
    console.log("%c[loom-nflx] manifest captured", tag, `movieId=${result.movieId} · ${NS.tracks.length} text tracks`);
    NS.dumpTracks();
    const imageOnly = NS.tracks.filter((t) => !t.hasWebVtt && !t.none && !t.forced);
    if (imageOnly.length) {
      console.warn(
        "[loom-nflx] %d track(s) have NO webvtt profile — likely IMAGE-BASED (OCR-only, out of scope): %o",
        imageOnly.length,
        imageOnly.map((t) => `${t.language} [${t.profiles.join(",") || "none"}]`),
      );
    }
  }

  const safe = (fn) => {
    try {
      return fn();
    } catch (e) {
      return `ERR: ${e && e.message}`;
    }
  };

  NS.player = function () {
    return safe(() => {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const sid = vp.getAllPlayerSessionIds()[0];
      return vp.getVideoPlayerBySessionId(sid);
    });
  };

  NS.time = function () {
    const p = NS.player();
    const vid =
      document.querySelector("#appMountPoint video") || document.querySelector("video");
    const r = {
      "player.getCurrentTime()": p && p.getCurrentTime ? safe(() => p.getCurrentTime()) : "n/a",
      "player.getDuration()": p && p.getDuration ? safe(() => p.getDuration()) : "n/a (use <video>)",
      "video.currentTime (ms)": vid ? Math.round(vid.currentTime * 1000) : "no <video>",
      "video.duration (ms)": vid ? Math.round(vid.duration * 1000) : "no <video>",
    };
    console.table(r);
    return r;
  };

  NS.dom = function () {
    const vid = document.querySelector("[data-videoid]");
    const r = {
      'div[data-uia="video-canvas"] (overlay anchor)': !!document.querySelector('div[data-uia="video-canvas"]'),
      ".watch-video--player-view (fallback anchor)": !!document.querySelector(".watch-video--player-view"),
      "#appMountPoint video": !!document.querySelector("#appMountPoint video"),
      'div[data-uia="controls-standard"]': !!document.querySelector('div[data-uia="controls-standard"]'),
      "[data-videoid] → videoId": vid ? vid.dataset.videoid : null,
    };
    console.table(r);
    return r;
  };

  NS.dumpTracks = function () {
    const view = NS.tracks.map(({ _raw, ...rest }) => rest);
    console.table(view);
    return view;
  };

  function downloadText(name, text) {
    const blob = new Blob([text], { type: "text/vtt" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  NS.fetchSample = async function (lang) {
    if (!NS.tracks.length) {
      console.warn("[loom-nflx] no manifest yet — start playback (or switch subtitle language) first.");
      return;
    }
    const t =
      NS.tracks.find((x) => x.language === lang && x.hasWebVtt) ||
      NS.tracks.find((x) => x.hasWebVtt);
    if (!t) {
      console.warn("[loom-nflx] no WebVTT track available — all tracks may be image-based:", NS.dumpTracks());
      return;
    }
    const dl = t._raw.ttDownloadables[WEBVTT_PROFILE];
    const url =
      (dl.urls && (dl.urls[0].url || Object.values(dl.urls[0])[0])) ||
      (dl.downloadUrls && Object.values(dl.downloadUrls)[0]);
    if (!url) {
      console.warn("[loom-nflx] WebVTT descriptor had no URL:", dl);
      return;
    }
    console.log("[loom-nflx] GET", url);
    const res = await fetch(url);
    const body = await res.text();
    console.log("%c[loom-nflx] sample fetched", ok, `lang=${t.language} status=${res.status} bytes=${body.length}`);
    console.log(body.slice(0, 800) + (body.length > 800 ? "\n…(truncated)…" : ""));
    NS.lastSample = { lang: t.language, status: res.status, body };
    downloadText(`netflix-${t.language}.vtt`, body);
    console.log("[loom-nflx] downloaded netflix-%s.vtt — save it over spike/netflix/sample-subs-ja.vtt", t.language);
    return NS.lastSample;
  };

  console.log("%c[loom-nflx] capture kit installed", tag);
  console.log("Now: start playback (or change subtitle language). Then call:");
  console.log("  __loomNflx.dumpTracks()  |  __loomNflx.dom()  |  __loomNflx.time()  |  await __loomNflx.fetchSample('ja')");
  // Eager probe of the surfaces that don't need the manifest.
  NS.dom();
  console.log("[loom-nflx] player object:", NS.player());
})();
