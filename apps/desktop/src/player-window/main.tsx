// Loom Player — single integrated window (MOBILE_ROADMAP.md §5a).
//
// One transparent Tauri window: libmpv renders the video into a GtkGLArea
// BEHIND this webview (reparented Rust-side by player_attach); this DOM is
// the caption stack (romaji + ruby Top + native Bottom) + transport bar +
// pause-gloss definition card, painted over the video.  VLC-style: video,
// captions, and controls in one window.
//
// All caption plumbing is the shared @loom/player-ui seam stack; the mpv
// render engine feeds the PlayheadSource via "mpv-prop" events (src/player/
// mpv.ts), identical to the old IPC path — the UI never knew which engine
// draws the pixels.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "./controls.css";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { CaptionStream } from "@loom/player-ui/captions/stream";
import { autoPick } from "@loom/player-ui/captions/auto-pick";
import {
  isDefinable,
  normalizeDefineSourceLang,
} from "@loom/player-ui/annotate/define-lang";
import { getDefineCapabilities } from "@loom/player-ui/annotate/capabilities";
import { buildAnnotateMap } from "@loom/player-ui/annotate/build-map";
import { buildRomanizeMap } from "@loom/player-ui/romanize/build-map";
import { buildRichSegments } from "@loom/player-ui/orthography/build-segments";
import { AnnotatedText } from "@loom/player-ui/components/annotated-text";
import { DefinitionCard } from "@loom/player-ui/components/definition-card";
import type { AnnotateResult } from "@loom/player-ui/annotate/types";
import type { RomanizeMap } from "@loom/player-ui/romanize/types";
import type { CaptionEvent } from "@loom/player-ui/captions/types";

import {
  attachPlayer,
  cyclePause,
  fetchTrackList,
  fontAdvanceRatios,
  getMpvState,
  initMpvEvents,
  type MpvTrack,
  mpvPlayhead,
  nudgeDomCapture,
  onMpvState,
  addLoomSubs,
  removeSub,
  seekRelative,
  seekToMs,
  setAudioLang,
  setAudioTrack,
  setMute,
  setSecondarySubTrack,
  setSpeed,
  setSubTrack,
  setVolume,
  startMpv,
  toggleAbLoop,
} from "../player/mpv";
import { SettingsPanel } from "../settings/SettingsPanel";
import {
  audioLangAliases,
  fetchTrackSource,
  loadMedia,
  selectStudyTracks,
  type LoadedMedia,
} from "../player/tracks";
import {
  buildOriginalAss,
  buildPlainAss,
  chooseSongLang,
  splitAssSongs,
  type SongEvent,
} from "../player/songs";
import { buildSongAids, type SongAidsInput } from "../player/song-aids";
import type { SplitLang } from "../player/subs-split";
import { getSetting, publishTracks, usePlayerStyles } from "../settings/model";
import { storage } from "../player/host";
import {
  getResume,
  getTrackSel,
  recordOpen,
  savePosition,
  saveTrackSel,
} from "../player/history";
import { siblingVideos } from "../player/playlist";
import { EmptyState } from "./EmptyState";
import { useAutoHideControls } from "./useAutoHideControls";
import { useOsd } from "./useOsd";
import { IconButton } from "./controls-kit";
import { SeekBar } from "./SeekBar";
import { PlayerSelect, type SelectOption } from "./PlayerSelect";
import {
  CloseIcon,
  FolderIcon,
  GearIcon,
  LoopIcon,
  MaximizeIcon,
  MinimizeIcon,
  MuteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  VolumeIcon,
} from "./icons";

// Video containers the picker + drag-drop accept.
const VIDEO_EXTS = ["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"];

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// The language the user is studying (Top line + furigana/romaji + audio).
// Persisted; default Japanese.  (A picker for this is a future setting.)
const STUDY_LANG =
  localStorage.getItem("loom_player_study_lang") || "ja";

const GLOSS_OVERRIDE_KEY = "loom_dictionary_gloss_lang";

const VOLUME_KEY = "loom_player_volume";
const INITIAL_VOLUME = (() => {
  const s = localStorage.getItem(VOLUME_KEY);
  const n = s == null ? 100 : Number(s);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100;
})();

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// Auto-advance to the next file in the folder when one finishes (default on).
const AUTOPLAY_KEY = "loom_player_autoplay_next";
const INITIAL_AUTOPLAY = localStorage.getItem(AUTOPLAY_KEY) !== "0";

interface CardState {
  word: string;
  lemma: string;
  reading: string | null;
  rect: DOMRect;
}

// Subtitle mode: Loom's own captions, or an original track via libass (Loom off).
type SubMode = "loom" | "target" | "native" | "both";

// Raw material for rendering one track's original subs via libass.
interface TrackSource {
  /** Raw .ass text (styling preserved), or null for SRT/VTT. */
  text: string | null;
  events: CaptionEvent[];
  /** Base language code (ja/zh/ko/en/…) for filtering a bilingual .ass. */
  lang: SplitLang;
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function trackLabel(t: MpvTrack): string {
  const parts = [t.lang, t.title].filter(Boolean);
  return parts.length ? parts.join(" · ") : `Track ${t.id ?? "?"}`;
}

function readGloss(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(GLOSS_OVERRIDE_KEY) ?? "null");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function PlayerWindow() {
  const [attached, setAttached] = useState(false);
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [nativeId, setNativeId] = useState<string | null>(null);
  const [annotate, setAnnotate] = useState<AnnotateResult | null>(null);
  const [romanize, setRomanize] = useState<RomanizeMap | null>(null);
  // Top-line texts, set once the tracks load.  The annotate/romanize build
  // reads these — kept in state so changing the phonetic system rebuilds ONLY
  // the reading maps, without re-fetching/re-extracting the tracks.
  const [targetTexts, setTargetTexts] = useState<string[]>([]);
  const [currentTarget, setCurrentTarget] = useState<CaptionEvent | null>(null);
  const [currentNative, setCurrentNative] = useState<CaptionEvent | null>(null);
  const [paused, setPaused] = useState(false);
  const [mpvState, setMpvState] = useState(getMpvState());
  const mpvStateRef = useRef(mpvState);
  const [card, setCard] = useState<CardState | null>(null);
  const [definable, setDefinable] = useState(false);
  const [glossOverride, setGlossOverride] = useState<string | null>(readGloss);
  // Audio defaults ON (the "start muted" directive is lifted).  Mute is a
  // plain in-session toggle; volume (below) is what's persisted.
  const [muted, setMuted] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState(false);
  // Count of open control-bar dropdowns — pins the auto-hiding bar open while a
  // menu is up (so it can't hide out from under an open menu).
  const [openMenus, setOpenMenus] = useState(0);
  const handleMenuOpen = useCallback((o: boolean) => {
    setOpenMenus((n) => Math.max(0, n + (o ? 1 : -1)));
  }, []);
  // Playback volume 0–100 (persisted).  Independent of mute; raising it unmutes.
  const [vol, setVol] = useState(INITIAL_VOLUME);
  const volRef = useRef(INITIAL_VOLUME);
  const [fullscreen, setFullscreen] = useState(false);
  // A-B loop cycle: 0 none · 1 A set · 2 looping (A→B).  mpv's `ab-loop`
  // command cycles the engine; we mirror the state for the button label.
  const [loopState, setLoopState] = useState<0 | 1 | 2>(0);
  // Window viewport (CSS px) for picture-relative caption scaling.
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  // mpv's own tracks (audio + embedded subs) for the track pickers.  Loom's DOM
  // captions use the sidecar-extracted tracks (targetId/nativeId) separately.
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [aid, setAid] = useState<number | null>(null);

  // Folder playlist: the sibling video files of the open media, naturally
  // sorted.  Drives the prev/next controls + next-episode auto-advance.
  const [playlist, setPlaylist] = useState<string[]>([]);
  const playlistRef = useRef<string[]>([]);
  playlistRef.current = playlist;
  const [autoplayNext, setAutoplayNext] = useState(INITIAL_AUTOPLAY);
  const autoplayRef = useRef(autoplayNext);
  autoplayRef.current = autoplayNext;

  // Settings-driven styles from the shared store.  The SettingsPanel is an
  // in-window overlay (gear button) — no separate window, no cross-window
  // "remote" state.
  const styles = usePlayerStyles();
  // Latest phonetic settings, read by the (styles-independent) load-effect when
  // fetching the song reading aids — so a phonetic-system change doesn't re-run
  // the heavy track load.
  const phoneticRef = useRef({
    phoneticSystem: styles.phoneticSystem,
    longVowelMode: styles.longVowelMode,
  });
  phoneticRef.current = {
    phoneticSystem: styles.phoneticSystem,
    longVowelMode: styles.longVowelMode,
  };

  const streamRef = useRef<CaptionStream | null>(null);
  if (!streamRef.current) streamRef.current = new CaptionStream();

  // The mpv sid of the currently-attached Loom songs track (OP/ED animation
  // preserved via libass), or null.  Removed before a replacement is added on
  // track switch; a new loadfile clears external subs on its own.
  const loomSubIdRef = useRef<number | null>(null);

  // Time intervals (ms) of the currently-displayed song events.  While the
  // playhead is inside one, the DOM captions are suppressed (the animated song
  // + its ASS aids are the only text on screen).  A ref, read in render against
  // the reactive mpvState.timeMs — no separate playhead subscription needed.
  const songIntervalsRef = useRef<{ start: number; end: number }[]>([]);

  // "Original subtitles" mode — turns Loom fully OFF and renders the original
  // track(s) via libass, so the app doubles as a plain player.  "loom" is the
  // Loom experience (DOM captions + song-animation preservation).
  const [subMode, setSubMode] = useState<SubMode>("loom");
  // Bumped when a file's captions finish loading, to re-run the libass
  // reconcile effect after the source refs below are populated.
  const [loadNonce, setLoadNonce] = useState(0);
  // Source material the reconcile effect needs, set by the caption-loading
  // effect.  For Loom mode: a builder that assembles the chosen-language songs
  // .ass (OP/ED animation) WITH position-aware furigana + romaji aids, given
  // the current toggle state (so flipping romanize/annotation rebuilds it
  // without re-fetching).  For the Original modes: each Loom track's raw text +
  // events + language.
  const songsAidsBuilderRef = useRef<
    ((opts: { romaji: boolean; furigana: boolean }) => string | null) | null
  >(null);
  const targetSrcRef = useRef<TrackSource | null>(null);
  const nativeSrcRef = useRef<TrackSource | null>(null);
  // mpv ids of the sub tracks added for an Original mode (removed on mode/track
  // change) — kept separate from the Loom songs track (loomSubIdRef).
  const origSubIdsRef = useRef<number[]>([]);

  // Latest media, read by the position-autosave interval + load-time save.
  const mediaRef = useRef<LoadedMedia | null>(media);
  mediaRef.current = media;
  // Bump to re-read the recents list on the start screen.
  const [recentsKey, setRecentsKey] = useState(0);

  // Player chrome (controls + cursor) auto-hides while playing; pinned when
  // paused, settings open, a dropdown is up, or no media loaded.
  const keepControls =
    mpvState.paused || showSettings || openMenus > 0 || !media;
  const { visible: controlsVisible } = useAutoHideControls(keepControls);
  const [osd, showOsd] = useOsd();
  // Debounce timer shared by the video click/double-click handlers (defined
  // after toggleFullscreen, below).
  const clickTimer = useRef<number | null>(null);
  // Playlist prev/next, wired below (after loadPath).  Held in refs so the
  // keyboard handler — declared before them — can call the latest without a
  // TDZ reference or re-subscribing on every render.
  const goPrevRef = useRef<() => void>(() => {});
  const goNextRef = useRef<() => void>(() => {});

  // Attach the video surface + wire mpv events, once.
  useEffect(() => {
    void (async () => {
      try {
        await attachPlayer();
        await initMpvEvents();
        setAttached(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    const offState = onMpvState(() => {
      const s = getMpvState();
      mpvStateRef.current = s;
      setMpvState(s);
    });
    const offPause = mpvPlayhead.onPausedChange((p) => {
      setPaused(p);
      if (!p) setCard(null);
      showOsd(p ? "⏸" : "▶");
    });
    return () => {
      offState();
      offPause();
      // Persist the final position so a reload/close resumes where we were.
      const m = mediaRef.current;
      const s = mpvStateRef.current;
      if (m && s.durationMs > 0 && s.timeMs > 0) {
        savePosition(m.path, s.timeMs, s.durationMs);
      }
      // NOTE: teardown of the native mpv/render engine is owned by the Rust
      // window-close handler (player_teardown), which runs on the GTK main
      // thread so it can free the render context in the right order.  Calling
      // it from here (a webview context) would race that + use-after-free.
      void streamRef.current?.stop();
    };
  }, [showOsd]);

  // Apply + persist mute whenever it changes or a new file loads (the engine
  // already starts muted; this keeps it in sync after user toggles / loads).
  useEffect(() => {
    if (attached) void setMute(muted);
  }, [muted, attached, media]);

  // Apply the persisted volume once attached (and on each new file).
  useEffect(() => {
    if (attached) void setVolume(volRef.current).catch(() => {});
  }, [attached, media]);

  const changeVolume = useCallback(
    (v: number) => {
      const c = Math.max(0, Math.min(100, Math.round(v)));
      volRef.current = c;
      setVol(c);
      localStorage.setItem(VOLUME_KEY, String(c));
      void setVolume(c).catch(() => {});
      // Raising the volume unmutes so the slider is immediately audible.
      if (c > 0) setMuted((m) => (m ? false : m));
      showOsd(c === 0 ? "🔇 0%" : `🔊 ${c}%`);
    },
    [showOsd],
  );

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      showOsd(next ? "🔇 Muted" : "🔊 Unmuted");
      return next;
    });
  }, [showOsd]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => {
      const next = !f;
      getCurrentWindow()
        .setFullscreen(next)
        .catch((e) => console.error("[Loom Player] setFullscreen:", e));
      return next;
    });
  }, []);

  // Click the video to play/pause; double-click to toggle fullscreen.  The 200ms
  // debounce lets a double-click cancel the pending single-click pause.
  const onVideoClick = useCallback(() => {
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => void cyclePause(), 200);
  }, []);
  const onVideoDblClick = useCallback(() => {
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    toggleFullscreen();
  }, [toggleFullscreen]);

  const cycleAbLoop = useCallback(() => {
    void toggleAbLoop();
    setLoopState((s) => {
      const next = ((s + 1) % 3) as 0 | 1 | 2;
      showOsd(next === 0 ? "A–B loop off" : next === 1 ? "A–B: A set" : "A–B: looping");
      return next;
    });
  }, [showOsd]);

  const stepSpeed = useCallback(
    (dir: number) => {
      const cur = mpvStateRef.current.speed;
      let idx = SPEEDS.reduce(
        (best, s, i) => (Math.abs(s - cur) < Math.abs(SPEEDS[best] - cur) ? i : best),
        0,
      );
      idx = Math.max(0, Math.min(SPEEDS.length - 1, idx + dir));
      void setSpeed(SPEEDS[idx]);
      showOsd(`${SPEEDS[idx]}×`);
    },
    [showOsd],
  );

  // Keyboard shortcuts — skipped while typing in a settings field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable
      ) {
        return;
      }
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          void cyclePause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          void seekRelative(e.shiftKey ? -60 : -5);
          showOsd(e.shiftKey ? "⏪ 60s" : "⏪ 5s");
          break;
        case "ArrowRight":
          e.preventDefault();
          void seekRelative(e.shiftKey ? 60 : 5);
          showOsd(e.shiftKey ? "⏩ 60s" : "⏩ 5s");
          break;
        case "ArrowUp":
          e.preventDefault();
          changeVolume(volRef.current + 5);
          break;
        case "ArrowDown":
          e.preventDefault();
          changeVolume(volRef.current - 5);
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "Escape":
          setFullscreen(false);
          getCurrentWindow()
            .setFullscreen(false)
            .catch((e) => console.error("[Loom Player] setFullscreen:", e));
          break;
        case "m":
          e.preventDefault();
          toggleMute();
          break;
        case "l":
          e.preventDefault();
          cycleAbLoop();
          break;
        case "[":
          e.preventDefault();
          stepSpeed(-1);
          break;
        case "]":
          e.preventDefault();
          stepSpeed(1);
          break;
        case "Backspace":
          e.preventDefault();
          void setSpeed(1);
          showOsd("1×");
          break;
        case "<":
          e.preventDefault();
          goPrevRef.current();
          break;
        case ">":
          e.preventDefault();
          goNextRef.current();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeVolume, toggleFullscreen, cycleAbLoop, stepSpeed, toggleMute, showOsd]);

  // Track the window size (CSS px) for picture-relative caption scaling.
  useEffect(() => {
    const measure = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // Re-measure shortly after a fullscreen toggle — the resize event can lag the
  // window-manager transition.
  useEffect(() => {
    const t = window.setTimeout(
      () => setViewport({ w: window.innerWidth, h: window.innerHeight }),
      120,
    );
    return () => window.clearTimeout(t);
  }, [fullscreen]);

  // Read mpv's track list a beat after a file loads (once setAudioLang has
  // applied), then seed the audio/sub pickers from what mpv actually selected.
  useEffect(() => {
    if (!attached || !media) return;
    const t = window.setTimeout(() => void fetchTrackList().then(setTracks), 300);
    return () => window.clearTimeout(t);
  }, [attached, media]);

  useEffect(() => {
    setAid(tracks.find((t) => t.type === "audio" && t.selected)?.id ?? null);
  }, [tracks]);

  useEffect(() => {
    streamRef.current?.setCallbacks({
      onActiveChange: (d) => {
        setCurrentTarget(d.target);
        setCurrentNative(d.native);
      },
    });
  }, []);

  // Selection is mirrored to the shared store so the main window's settings
  // panel can render the track pickers and override the auto-pick.  These
  // wrappers set local state AND persist; the store subscription below adopts
  // panel-side changes.
  const applyTargetId = useCallback((id: string | null) => {
    setTargetId(id);
    void storage.set({ loom_target_track_id: id });
  }, []);
  const applyNativeId = useCallback((id: string | null) => {
    setNativeId(id);
    void storage.set({ loom_native_track_id: id });
  }, []);

  // Control-bar track changes: apply AND remember the pick for this file, so
  // reopening it (or advancing to the next same-release episode) restores it.
  // mediaRef is current here — these fire only on user interaction, never
  // during load (unlike applyTargetId, which loadPath also calls).
  const chooseTargetId = useCallback(
    (id: string | null) => {
      applyTargetId(id);
      const p = mediaRef.current?.path;
      if (p) saveTrackSel(p, { targetId: id });
    },
    [applyTargetId],
  );
  const chooseNativeId = useCallback(
    (id: string | null) => {
      applyNativeId(id);
      const p = mediaRef.current?.path;
      if (p) saveTrackSel(p, { nativeId: id });
    },
    [applyNativeId],
  );

  const loadPath = useCallback(async (picked: string) => {
    // Save the outgoing file's position before we tear it down.
    const prevM = mediaRef.current;
    const prevS = mpvStateRef.current;
    if (prevM && prevS.durationMs > 0 && prevS.timeMs > 0) {
      savePosition(prevM.path, prevS.timeMs, prevS.durationMs);
    }
    setError(null);
    setBusy("Starting playback…");
    setMedia(null);
    setTargetId(null);
    setNativeId(null);
    setAnnotate(null);
    setRomanize(null);
    setCard(null);
    setLoopState(0); // loadfile clears mpv's A-B loop
    setTracks([]);
    setSubMode("loom"); // every file starts in Loom mode
    songIntervalsRef.current = []; // loadfile clears the previous Loom songs track
    loomSubIdRef.current = null;
    origSubIdsRef.current = [];
    // Clear cached sources so a reconcile that races the new load can't attach
    // the PREVIOUS file's songs/original .ass (the load-effect repopulates these
    // then bumps loadNonce to run the reconcile for real).
    songsAidsBuilderRef.current = null;
    targetSrcRef.current = null;
    nativeSrcRef.current = null;
    try {
      await startMpv(picked);
      // Resume where we left off (watch-later), if worth it.
      const resume = getResume(picked);
      if (resume != null) {
        void seekToMs(resume);
        showOsd(`Resumed · ${fmtTime(resume)}`);
      }
      setBusy("Scanning subtitle tracks…");
      const tScan = performance.now();
      const loaded = await loadMedia(picked);
      console.debug(
        `[Loom Player] scan+extract in ${Math.round(performance.now() - tScan)}ms ` +
          `(${loaded.tracks.length} tracks)`,
      );
      // Record in recents (title from scan metadata, else filename).
      recordOpen(picked, loaded.metadata.title || baseName(picked));
      setRecentsKey((k) => k + 1);
      setMedia(loaded);
      // "Your language" comes from the panel's preference (persisted); fall
      // back to the browser UI language when unset.
      const pref = getSetting("nativeLangPref");
      const userLang = (pref || navigator.language).split("-")[0].toLowerCase();
      // Prefer the study language (JA) for Top + the user's language for
      // Bottom; fall back to generic auto-pick when neither is present.
      const study = selectStudyTracks(loaded.tracks, STUDY_LANG, userLang);
      const fallback = autoPick(loaded.tracks.map((t) => t.caption), userLang);
      // Publish the file's tracks for the panel BEFORE writing the selection,
      // so the panel has the list when it sees the new ids.
      publishTracks(
        loaded.tracks.map((tr) => ({
          id: tr.caption.id,
          name: tr.caption.name,
          languageCode: tr.caption.languageCode,
          kind: (tr.caption.kind as string) ?? "manual",
        })),
      );
      // Prefer the user's remembered pick for this file; else the fresh
      // auto-pick.  Either way we OVERWRITE any stale id persisted from a
      // previous file, so the panel never shows a dead id.
      const hasTrack = (id: string | null | undefined): id is string =>
        !!id && loaded.tracks.some((t) => t.caption.id === id);
      const saved = getTrackSel(picked);
      const autoTarget =
        study.targetId ?? fallback.target?.id ?? loaded.tracks[0]?.caption.id ?? null;
      applyTargetId(hasTrack(saved?.targetId) ? saved!.targetId! : autoTarget);
      let chosenNative = study.nativeId ?? fallback.native?.id ?? null;
      if (saved && "nativeId" in saved) {
        if (saved.nativeId === null) chosenNative = null;
        else if (hasTrack(saved.nativeId)) chosenNative = saved.nativeId;
      }
      applyNativeId(chosenNative);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [applyTargetId, applyNativeId, showOsd]);

  // Perf-testing convenience: LOOM_OPEN=<path> (read Rust-side) auto-loads a
  // file on launch and fullscreens on the 4K monitor, so a render measurement
  // is one command with no clicking.  No-op (command returns null) in normal use.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!attached || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    void invoke<string | null>("player_launch_file").then(async (p) => {
      if (!p) return;
      try {
        const w = getCurrentWindow();
        await w.setPosition(new PhysicalPosition(0, 0)); // 4K monitor at origin
        await w.setFullscreen(true);
        setFullscreen(true);
      } catch (e) {
        console.error("[Loom Player] auto-open:", e);
      }
      void loadPath(p);
    });
  }, [attached, loadPath]);

  // Autosave the playback position every few seconds so a crash/close resumes.
  useEffect(() => {
    const id = window.setInterval(() => {
      const m = mediaRef.current;
      const s = mpvStateRef.current;
      if (m && s.durationMs > 0 && s.timeMs > 0) {
        savePosition(m.path, s.timeMs, s.durationMs);
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  // Folder playlist: rescan the open file's directory whenever it changes.
  useEffect(() => {
    const p = media?.path;
    if (!p) {
      setPlaylist([]);
      return;
    }
    let alive = true;
    void siblingVideos(p).then((list) => {
      if (alive) setPlaylist(list);
    });
    return () => {
      alive = false;
    };
  }, [media?.path]);

  // Prev/next episode by folder order.  Read the refs (not the closure) so a
  // stale playlist/media can't send us to the wrong file.
  const goPrev = useCallback(() => {
    const pl = playlistRef.current;
    const i = mediaRef.current ? pl.indexOf(mediaRef.current.path) : -1;
    if (i > 0) void loadPath(pl[i - 1]);
  }, [loadPath]);
  const goNext = useCallback(() => {
    const pl = playlistRef.current;
    const i = mediaRef.current ? pl.indexOf(mediaRef.current.path) : -1;
    if (i >= 0 && i < pl.length - 1) void loadPath(pl[i + 1]);
  }, [loadPath]);
  goPrevRef.current = goPrev;
  goNextRef.current = goNext;

  const toggleAutoplay = useCallback(() => {
    setAutoplayNext((v) => {
      const next = !v;
      localStorage.setItem(AUTOPLAY_KEY, next ? "1" : "0");
      showOsd(next ? "Autoplay next: on" : "Autoplay next: off");
      return next;
    });
  }, [showOsd]);

  // Auto-advance to the next episode when the current file ends (when enabled
  // and a next exists).  eof resets on the next startMpv, so this fires once.
  useEffect(() => {
    if (!mpvState.eof || !autoplayRef.current) return;
    const pl = playlistRef.current;
    const cur = mediaRef.current?.path;
    const i = cur ? pl.indexOf(cur) : -1;
    if (i >= 0 && i < pl.length - 1) {
      showOsd("⏭ Next episode");
      void loadPath(pl[i + 1]);
    }
  }, [mpvState.eof, loadPath, showOsd]);

  // Drag-and-drop a video file onto the window to open it.
  useEffect(() => {
    let un: (() => void) | undefined;
    let alive = true;
    void getCurrentWebviewWindow()
      .onDragDropEvent((e) => {
        if (e.payload.type === "drop") {
          const p = e.payload.paths.find((x) =>
            VIDEO_EXTS.some((ext) => x.toLowerCase().endsWith("." + ext)),
          );
          if (p) void loadPath(p);
        }
      })
      .then((f) => {
        if (alive) un = f;
        else f();
      });
    return () => {
      alive = false;
      un?.();
    };
  }, [loadPath]);

  // Adopt panel-side selection overrides: when the store ids change (from the
  // settings window), take them if they name a track in the current media.
  useEffect(() => {
    return storage.onChanged((c: Record<string, unknown>) => {
      const has = (id: string) => media?.tracks.some((t) => t.caption.id === id);
      const tc = c["loom_target_track_id"] as { newValue?: unknown } | undefined;
      if (tc && "newValue" in tc) {
        const v = tc.newValue;
        if (typeof v === "string" && has(v)) setTargetId(v);
      }
      const nc = c["loom_native_track_id"] as { newValue?: unknown } | undefined;
      if (nc && "newValue" in nc) {
        const v = nc.newValue;
        if (v === null) setNativeId(null);
        else if (typeof v === "string" && has(v)) setNativeId(v);
      }
    });
  }, [media]);

  const pickFile = useCallback(async () => {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Video", extensions: ["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"] },
      ],
    });
    if (typeof picked === "string") await loadPath(picked);
  }, [loadPath]);

  const targetTrack = useMemo(
    () => media?.tracks.find((t) => t.caption.id === targetId) ?? null,
    [media, targetId],
  );
  const nativeTrack = useMemo(
    () => media?.tracks.find((t) => t.caption.id === nativeId) ?? null,
    [media, nativeId],
  );
  const targetLang = targetTrack?.caption.languageCode ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!targetLang) {
      setDefinable(false);
      return;
    }
    getDefineCapabilities().then((caps) => {
      if (!cancelled) setDefinable(isDefinable(caps, targetLang));
    });
    return () => {
      cancelled = true;
    };
  }, [targetLang]);

  // Track selection → events + stream.  DISPLAY-FIRST: as soon as the events
  // load and the stream starts, the plain subtitles show (busy cleared) — the
  // furigana/romaji maps build separately (below) and fill in after.  Kept
  // SEPARATE from that build so switching phonetic system / long-vowel rebuilds
  // only the reading maps, never re-fetching/re-extracting the tracks (the slow
  // part) or restarting the stream.
  useEffect(() => {
    if (!media || !targetTrack) return;
    let cancelled = false;
    const stream = streamRef.current!;
    (async () => {
      try {
        setBusy("Loading captions…");
        const t0 = performance.now();
        const [targetSrc, nativeSrc] = await Promise.all([
          fetchTrackSource(targetTrack),
          nativeTrack
            ? fetchTrackSource(nativeTrack)
            : Promise.resolve({ text: null, events: [] as CaptionEvent[] }),
        ]);
        if (cancelled) return;
        const nativeEvents = nativeSrc.events;

        const base = (c: string): SplitLang =>
          (((c || "").toLowerCase().split("-")[0] || "other") as SplitLang);
        const targetBase = base(targetTrack.caption.languageCode);
        const nativeBase = base(
          nativeTrack?.caption.languageCode ??
            (getSetting("nativeLangPref") as string) ??
            navigator.language,
        );

        // Publish each Loom track's raw source for the "Original subtitles" modes.
        targetSrcRef.current = {
          text: targetSrc.text,
          events: targetSrc.events,
          lang: targetBase,
        };
        nativeSrcRef.current = nativeTrack
          ? { text: nativeSrc.text, events: nativeSrc.events, lang: nativeBase }
          : null;

        // Song-line handling: OP/ED/karaoke events → mpv/libass (original
        // animation preserved), dialogue → Loom's DOM captions.  Loom shows
        // ONE song language (study lang > user lang) and, while a song plays,
        // suppresses all other subtitle events (below, via songIntervalsRef).
        // Only applies to ASS tracks that carry song styles.  The actual
        // sub-add happens in the reconcile effect below (owns all libass state).
        const split = targetSrc.text ? splitAssSongs(targetSrc.text) : null;
        let targetEvents = targetSrc.events;
        let songIntervals: { start: number; end: number }[] = [];
        let chosenSongs: SongEvent[] = [];
        let songLangFull = "";
        if (split && split.songs.length > 0) {
          const displayLang = chooseSongLang(
            split.songs,
            split.styleLangs,
            targetBase,
            nativeBase,
          );
          // Select whole song STYLES by their dominant language, so a JP song
          // with a few English lines stays intact.
          chosenSongs = split.songs.filter(
            (s) => (split.styleLangs.get(s.styleName) ?? s.lang) === displayLang,
          );
          songIntervals = chosenSongs.map((s) => ({ start: s.start, end: s.end }));
          // The chosen songs' full language code (with script) for /annotate +
          // /romanize — from the matching track when we can, else a sane default.
          songLangFull =
            displayLang === targetBase
              ? targetTrack.caption.languageCode
              : displayLang === nativeBase
                ? nativeTrack?.caption.languageCode ?? displayLang
                : displayLang === "zh"
                  ? "zh-Hant"
                  : displayLang;
          // Remove ALL song events (any language) from the Top DOM stream so a
          // song never doubles as a flat Loom line.  The raw ASS may be
          // bilingual (external .scjp/.tcjp), so filter the TARGET track's OWN
          // language-split events by song timing rather than the whole file.
          const songKeys = new Set(split.songs.map((s) => `${s.start}|${s.end}`));
          targetEvents = targetSrc.events.filter(
            (e) => !songKeys.has(`${e.start}|${e.end}`),
          );
        }
        songIntervalsRef.current = songIntervals;
        songsAidsBuilderRef.current = null; // installed below, once aids fetched

        console.debug(
          `[Loom Player] events loaded in ${Math.round(performance.now() - t0)}ms ` +
            `(dialogue ${targetEvents.length}, native ${nativeEvents.length}` +
            `${songIntervals.length ? `, songs ${songIntervals.length}` : ""})`,
        );
        await stream.start({
          targetEvents,
          nativeEvents,
          targetLang: targetTrack.caption.languageCode,
          nativeLang: nativeTrack?.caption.languageCode ?? "",
        });
        if (cancelled) return;
        // Subtitles are DISPLAYING now — stop blocking on the reading aids.
        setBusy(null);
        // Play the audio in the language being studied (matches the Top
        // subs) — multi-dub files list English first, so we pick explicitly.
        void setAudioLang(audioLangAliases(targetTrack.caption.languageCode));
        setTargetTexts(targetEvents.map((e) => e.text));

        // Fetch the song reading aids (furigana spans + romaji) for the chosen
        // song language, then install the songs-.ass builder.  Done AFTER the
        // dialogue is showing so the aid fetch never delays the subtitles; the
        // songs track only matters during the OP/ED.  The builder takes the
        // live toggle state so the reconcile can add aids on/off without a
        // re-fetch.
        if (split && chosenSongs.length > 0 && songLangFull) {
          const songTexts = chosenSongs
            .map((s) => s.plainText.trim())
            .filter(Boolean);
          const phon =
            phoneticRef.current.phoneticSystem ??
            (songLangFull === "zh-Hant" ? "pinyin" : undefined);
          // Distinct base fonts of the chosen song styles — probe their real
          // libass advance ratios so furigana can align in the ORIGINAL font.
          const songFonts = Array.from(
            new Set(
              chosenSongs
                .map((s) => split.styles.get(s.styleName)?.fontName ?? "")
                .filter(Boolean),
            ),
          );
          const songBaseLang = songLangFull.split("-")[0].toLowerCase();
          const [anno, songRomaji, ratios] = await Promise.all([
            buildAnnotateMap(songTexts, {
              langCode: songLangFull,
              phoneticSystem: phon,
            }),
            buildRomanizeMap(songTexts, {
              langCode: songLangFull,
              phoneticSystem: phon,
              longVowelMode: phoneticRef.current.longVowelMode,
            }),
            fontAdvanceRatios(songFonts, media.path, songBaseLang),
          ]);
          if (cancelled) return;
          const aidsInput: SongAidsInput = {
            chosen: chosenSongs,
            styles: split.styles,
            romajiMap: songRomaji,
            spansMap: anno.spans,
            playResX: split.playResX,
            playResY: split.playResY,
            lang: songLangFull,
            advanceRatios: new Map(Object.entries(ratios)),
          };
          songsAidsBuilderRef.current = (opts) => {
            const aids = buildSongAids(aidsInput, opts);
            return split.buildSongsAss(
              aids.rawLines,
              aids.extraStyles,
              aids.extraEvents,
            );
          };
        }
        // Sources are populated — run the libass reconcile (adds the songs
        // track for Loom mode, or the original track(s) for an Original mode).
        setLoadNonce((n) => n + 1);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setBusy(null);
          // A failed switch must not leave the PREVIOUS track's subs showing
          // under a picker that now names a different track: drop the cached
          // sources, stop the DOM stream, and bump loadNonce so the reconcile
          // tears down the stale libass tracks (and adds nothing).
          songsAidsBuilderRef.current = null;
          targetSrcRef.current = null;
          nativeSrcRef.current = null;
          songIntervalsRef.current = [];
          void streamRef.current?.stop();
          setTargetTexts([]);
          setLoadNonce((n) => n + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [media, targetTrack, nativeTrack]);

  // Libass subtitle reconcile — owns ALL sub-add / sid state.  Runs after a
  // file finishes loading (loadNonce) and whenever the subtitle MODE changes.
  // Loom mode → the chosen-language songs track (OP/ED animation preserved);
  // Original modes → the original track(s) rebuilt with authentic styling,
  // Loom's DOM captions off.
  useEffect(() => {
    if (!media) return;
    let cancelled = false;
    (async () => {
      // Tear down whatever libass is currently showing.
      for (const id of origSubIdsRef.current) void removeSub(id);
      origSubIdsRef.current = [];
      if (loomSubIdRef.current != null) {
        void removeSub(loomSubIdRef.current);
        loomSubIdRef.current = null;
      }
      void setSecondarySubTrack("no");

      if (subMode === "loom") {
        // Assemble the songs .ass WITH aids per the current toggles (romaji =
        // romanization line, furigana = per-character annotation) — so flipping
        // either re-adds the songs track with/without the aid, no re-fetch.
        const build = songsAidsBuilderRef.current;
        const ass = build
          ? build({
              romaji: styles.romanizeEnabled,
              furigana: styles.annotateEnabled,
            })
          : null;
        if (ass) {
          try {
            const id = await addLoomSubs(ass);
            // If this run was superseded mid-add, remove the just-added track
            // (the "select" already stole the sid) — don't leak it untracked.
            if (id >= 0) {
              if (cancelled) void removeSub(id);
              else loomSubIdRef.current = id;
            }
          } catch (e) {
            console.debug("[Loom Player] songs sub-add failed:", e);
          }
        }
        return;
      }

      // Original modes: render the chosen track(s) via libass, Loom DOM off.
      const assFor = (src: TrackSource | null): string | null => {
        if (!src) return null;
        if (src.text) return buildOriginalAss(src.text, [src.lang]) ?? buildPlainAss(src.events);
        return buildPlainAss(src.events);
      };
      const add = async (ass: string | null): Promise<number> => {
        if (!ass) return -1;
        try {
          return await addLoomSubs(ass);
        } catch {
          return -1;
        }
      };
      const wantTarget = subMode === "target" || subMode === "both";
      const wantNative = subMode === "native" || subMode === "both";
      const tid = wantTarget ? await add(assFor(targetSrcRef.current)) : -1;
      const nid = wantNative ? await add(assFor(nativeSrcRef.current)) : -1;
      if (cancelled) {
        if (tid >= 0) void removeSub(tid);
        if (nid >= 0) void removeSub(nid);
        return;
      }
      if (tid >= 0) origSubIdsRef.current.push(tid);
      if (nid >= 0) origSubIdsRef.current.push(nid);
      // Each sub-add steals the primary sid, so set the final selection after
      // both are added: primary = video language, secondary = your language.
      if (subMode === "both") {
        if (tid >= 0) void setSubTrack(tid);
        if (nid >= 0) void setSecondarySubTrack(nid);
      } else if (tid >= 0) {
        void setSubTrack(tid);
      } else if (nid >= 0) {
        void setSubTrack(nid);
      }
    })();
    return () => {
      cancelled = true;
    };
    // styles.romanizeEnabled / annotateEnabled: in Loom mode, toggling them
    // rebuilds the songs .ass with/without the romaji / furigana aids.
  }, [subMode, loadNonce, media, styles.romanizeEnabled, styles.annotateEnabled]);

  // Build furigana/ruby + romaji maps for the current Top texts.  Depends on
  // the phonetic settings so changing them re-derives the reading in place —
  // the plain subtitles keep showing throughout (no re-fetch, no fl​icker).
  useEffect(() => {
    if (!targetLang || targetTexts.length === 0) {
      setAnnotate(null);
      setRomanize(null);
      return;
    }
    let cancelled = false;
    const lang = targetLang;
    // Phonetic system: the user's setting wins; else pinyin for Traditional
    // Chinese (Zhuyin deprecated); else the engine default.
    const phoneticSystem =
      styles.phoneticSystem ?? (lang === "zh-Hant" ? "pinyin" : undefined);
    const t0 = performance.now();
    void buildAnnotateMap(targetTexts, { langCode: lang, phoneticSystem }).then(
      (r) => {
        if (!cancelled) {
          setAnnotate(r);
          console.debug(
            `[Loom Player] annotation built in ${Math.round(performance.now() - t0)}ms`,
          );
        }
      },
    );
    void buildRomanizeMap(targetTexts, {
      langCode: lang,
      phoneticSystem,
      longVowelMode: styles.longVowelMode,
    }).then((r) => {
      if (!cancelled) setRomanize(r);
    });
    return () => {
      cancelled = true;
    };
  }, [targetTexts, targetLang, styles.phoneticSystem, styles.longVowelMode]);

  const onGlossLangChange = useCallback((code: string | null) => {
    setGlossOverride(code);
    localStorage.setItem(GLOSS_OVERRIDE_KEY, JSON.stringify(code));
  }, []);

  const onWordClick = useCallback(
    (word: string, lemma: string, reading: string | null, rect: DOMRect) => {
      setCard({ word, lemma, reading, rect });
    },
    [],
  );

  const interactive =
    paused && definable && !!currentTarget;
  const pausedText = paused ? currentTarget?.text.trim() ?? null : null;
  const romaji = currentTarget
    ? romanize?.get(currentTarget.text.trim()) ?? null
    : null;
  const tokens = pausedText ? annotate?.tokens.get(pausedText) ?? null : null;
  const spans = currentTarget
    ? annotate?.spans.get(currentTarget.text.trim()) ?? null
    : null;
  const wordInteractive = interactive && !!tokens && tokens.length > 0;

  // Annotation toggle: when off, strip ruby (spans) but keep word grouping
  // for the gloss (tokens still drive the clickable words).
  const renderSpans = styles.annotateEnabled ? spans : null;
  const segments = useMemo(() => {
    const text = currentTarget?.text.trim();
    if (!text) return null;
    return buildRichSegments({
      spans: renderSpans,
      rawText: text,
      variantTable: null,
      coalescePlain: !wordInteractive,
    });
  }, [currentTarget, renderSpans, wordInteractive]);

  // Picture-relative caption scaling: size fonts to the visible video PICTURE
  // (contain-fit within the window), not a fixed pixel size — so captions grow
  // in fullscreen and shrink in a small window, tracking the video.  Caption
  // sizes are authored at a 1080-tall reference; `captionScale` is the user's
  // multiplier on top.  Falls back to the full window height until mpv reports
  // the video's display size.
  const pictureHeight = (() => {
    const { w, h } = viewport;
    const va = mpvState.dheight > 0 ? mpvState.dwidth / mpvState.dheight : 0;
    if (va > 0 && w > 0 && h > 0) {
      return va > w / h ? w / va : h; // contain-fit picture height (CSS px)
    }
    return h;
  })();
  const scale = (pictureHeight / 1080) * styles.captionScale;
  const showRomaji = styles.romanizeEnabled && romaji;

  // A song is playing → its animation (libass) + ASS aids are the only text;
  // the DOM caption stack + definition card are suppressed.  Recomputed each
  // render against the reactive mpvState.timeMs (~4 Hz), so it flips on song
  // enter/exit without a separate playhead subscription.
  const songActive = songIntervalsRef.current.some(
    (iv) => mpvState.timeMs >= iv.start && mpvState.timeMs < iv.end,
  );
  // An "Original subtitles" mode is active → Loom is fully off (the original
  // track renders via libass); hide the whole DOM caption stack + card.
  const loomOff = subMode !== "loom";

  // Damage-driven capture: nudge the native engine to re-capture the DOM
  // overlay whenever anything VISIBLE in it changes, so the change composites
  // over the video.  Keyed on the derived overlay state (NOT raw playhead time),
  // so a nudge fires at caption boundaries / fades / toggles — not every frame.
  // Paused-state interactions (hover-glow, definition card) need no nudge: the
  // engine captures continuously while paused.  This is what lets 4K playback
  // stay smooth between caption changes (the engine idles the snapshot loop).
  //
  // `usePlayerStyles()` returns a FRESH object every render, so depend on a
  // serialized signature (small object; changes only on an actual style edit)
  // — depending on the object itself would fire this every render → continuous
  // nudges → the fix is undone.  Keeps live style preview during playback.
  const styleSig = JSON.stringify(styles);
  useEffect(() => {
    nudgeDomCapture();
  }, [
    media,
    busy,
    error,
    songActive,
    loomOff,
    fullscreen,
    showSettings,
    controlsVisible,
    osd,
    card,
    currentTarget?.text,
    currentNative?.text,
    romaji,
    segments,
    styleSig,
  ]);

  // Target (Top) + native (Bottom) render into their configured slots.
  const targetAtTop = styles.topSlot.startsWith("top");
  const nativeAtTop = styles.nativeSlot.startsWith("top");

  // Snap the speed dropdown to the nearest preset so it always shows a value
  // even after keyboard nudges.
  const nearestSpeed = SPEEDS.reduce(
    (b, s) => (Math.abs(s - mpvState.speed) < Math.abs(b - mpvState.speed) ? s : b),
    SPEEDS[0],
  );
  const audioTracks = tracks.filter((t) => t.type === "audio");
  // Playlist position for the prev/next controls.
  const plIndex = media ? playlist.indexOf(media.path) : -1;
  const hasPrev = plIndex > 0;
  const hasNext = plIndex >= 0 && plIndex < playlist.length - 1;
  // Compact base-language code, e.g. "ja-Hant" → "JA".
  const upper = (code: string | null | undefined): string =>
    (code || "").split("-")[0].toUpperCase();

  // A Loom track → dropdown option (name from the track title, code as a hint).
  const trackOption = (t: LoadedMedia["tracks"][number]): SelectOption => {
    const code = t.caption.languageCode;
    const nm = (t.caption.name || "").trim();
    return {
      value: t.caption.id,
      name: nm || code || "Track",
      sub: nm && code ? code : undefined,
    };
  };

  // Subtitle mode: Loom's own captions, or an original track via libass.
  const subModeOptions: SelectOption[] = [
    { value: "loom", name: "Loom" },
    { value: "target", name: "Original", sub: upper(targetTrack?.caption.languageCode) },
  ];
  if (nativeTrack) {
    subModeOptions.push({
      value: "native",
      name: "Original",
      sub: upper(nativeTrack.caption.languageCode),
    });
    subModeOptions.push({ value: "both", name: "Original", sub: "both" });
  }

  const videoOptions = media ? media.tracks.map(trackOption) : [];
  const youOptions: SelectOption[] = [
    { value: "", name: "None" },
    ...(media ? media.tracks.map(trackOption) : []),
  ];
  const audioOptions: SelectOption[] = audioTracks.map((t) => ({
    value: String(t.id ?? ""),
    name: trackLabel(t),
  }));
  const selAudio = audioTracks.find((t) => t.id === aid);
  const speedOptions: SelectOption[] = SPEEDS.map((s) => ({
    value: String(s),
    name: `${s}×`,
  }));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        cursor: controlsVisible ? "default" : "none",
        overflow: "hidden",
      }}
    >
      {/* 1. Video interaction surface — click = play/pause, double-click =
             fullscreen.  Lowest layer; caption words + controls sit above and
             capture their own clicks, so only "empty" video area toggles. */}
      {media && (
        <div
          onClick={onVideoClick}
          onDoubleClick={onVideoDblClick}
          style={{ position: "absolute", inset: 0, pointerEvents: "auto" }}
        />
      )}

      {/* 2. Caption zones — target + native render into their configured slots,
             styled from the shared settings.  Non-word areas are pointer-
             transparent so clicks fall through to the surface below (pause).
             While a song plays, the animated song (libass) + its ASS aids are
             the only text: the whole DOM stack is suppressed. */}
      {media && !songActive && !loomOff && (() => {
        const targetBlock = styles.topLineEnabled && segments && (
          <div style={{ textAlign: "center" }}>
            {showRomaji && (
              <div
                style={{
                  color: styles.romanization.color,
                  opacity: styles.romanization.opacity,
                  fontFamily: styles.romanization.fontFamily,
                  fontSize: styles.topFontSizePx * styles.romanizationFontRatio * scale,
                  fontStyle: "italic",
                  textShadow: styles.romanization.shadow,
                  marginBottom: 6,
                }}
              >
                {romaji}
              </div>
            )}
            <div
              style={{
                // Base foreign (Top) text — inherited by AnnotatedText's base
                // glyphs.  The over-ruby reading takes the Annotation color via
                // the `color` prop below (matches the extension's caption-
                // overlay: container = layer.color, ruby = annotationColor).
                color: styles.top.color,
                fontSize: styles.topFontSizePx * scale,
                lineHeight: 2.1,
                textShadow: styles.top.shadow,
                opacity: styles.top.opacity,
                pointerEvents: wordInteractive ? "auto" : "none",
                whiteSpace: "pre-wrap",
              }}
            >
              <AnnotatedText
                segments={segments}
                baseFontPxScaled={styles.topFontSizePx * scale}
                annotationRatio={styles.annotationFontRatio}
                color={styles.annotation.color}
                fontFamily={styles.top.fontFamily}
                variantColor={styles.annotation.color}
                variantFontFamily="inherit"
                highlightEnabled={false}
                cleanHighlightColor="transparent"
                collapseHighlightColor="transparent"
                tokens={tokens}
                interactive={wordInteractive}
                onWordClick={onWordClick}
              />
            </div>
          </div>
        );
        const nativeBlock = styles.bottomLineEnabled && currentNative && (
          <div
            style={{
              textAlign: "center",
              color: styles.bottom.color,
              opacity: styles.bottom.opacity,
              fontFamily: styles.bottom.fontFamily,
              fontSize: styles.bottomFontSizePx * scale,
              textShadow: styles.bottom.shadow,
              whiteSpace: "pre-wrap",
              marginTop: styles.lineSpacingPx,
            }}
          >
            {currentNative.text}
          </div>
        );
        return (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              padding: "2.5% 4% 5.5%",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: styles.lineSpacingPx }}>
              {targetAtTop && targetBlock}
              {nativeAtTop && nativeBlock}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: styles.lineSpacingPx }}>
              {!targetAtTop && targetBlock}
              {!nativeAtTop && nativeBlock}
            </div>
          </div>
        );
      })()}

      {/* 3. OSD — transient center-top feedback (volume / seek / speed / pause). */}
      {osd && (
        <div
          style={{
            position: "absolute",
            top: "10%",
            left: "50%",
            transform: "translateX(-50%)",
            pointerEvents: "none",
            background: "rgba(0,0,0,0.62)",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 12,
            fontSize: 22,
            fontWeight: 600,
            fontFamily: "system-ui, sans-serif",
            whiteSpace: "nowrap",
          }}
        >
          {osd}
        </div>
      )}

      {/* 4. Busy / error toast while a file is loaded (the start screen shows
             its own).  Top-center, non-interactive. */}
      {media && (busy || error) && (
        <div
          style={{
            position: "absolute",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            pointerEvents: "none",
            background: "rgba(0,0,0,0.6)",
            color: error ? "#f88" : "#fff",
            padding: "6px 14px",
            borderRadius: 10,
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
            maxWidth: "80vw",
            textAlign: "center",
          }}
        >
          {error ?? busy}
        </div>
      )}

      {/* 5. Bottom control bar — auto-hides while playing (pinned when paused,
             settings open, a dropdown is up, or the pointer is active). */}
      {media && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: controlsVisible ? "auto" : "none",
            opacity: controlsVisible ? 1 : 0,
            transition: "opacity 200ms ease",
            background:
              "linear-gradient(to top, rgba(8,8,12,0.92) 0%, rgba(8,8,12,0.55) 46%, rgba(8,8,12,0) 100%)",
            padding: "34px 18px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 11,
          }}
        >
          <SeekBar
            valueMs={mpvState.timeMs}
            durationMs={mpvState.durationMs}
            onSeek={(ms) => void seekToMs(ms)}
            formatTime={fmtTime}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {/* transport cluster */}
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              {playlist.length > 1 && (
                <IconButton
                  onClick={goPrev}
                  title="Previous in folder ( < )"
                  disabled={!hasPrev}
                >
                  <PrevIcon />
                </IconButton>
              )}
              <IconButton
                onClick={() => void cyclePause()}
                title={mpvState.paused ? "Play (space)" : "Pause (space)"}
                size={38}
                iconSize={22}
              >
                {mpvState.paused ? <PlayIcon /> : <PauseIcon />}
              </IconButton>
              {playlist.length > 1 && (
                <IconButton onClick={goNext} title="Next in folder ( > )" disabled={!hasNext}>
                  <NextIcon />
                </IconButton>
              )}
              {playlist.length > 1 && (
                <button
                  type="button"
                  className={autoplayNext ? "lp-auto on" : "lp-auto"}
                  onClick={toggleAutoplay}
                  title={`Autoplay next episode: ${autoplayNext ? "on" : "off"}`}
                >
                  <span className="lp-dot" />
                  AUTO
                </button>
              )}
            </div>

            {/* volume — slider reveals on hover */}
            <div className="lp-vol" style={{ marginLeft: 4 }}>
              <IconButton onClick={toggleMute} title={muted ? "Unmute (m)" : "Mute (m)"}>
                {muted || vol === 0 ? <MuteIcon /> : <VolumeIcon />}
              </IconButton>
              <input
                type="range"
                min={0}
                max={100}
                value={vol}
                onChange={(e) => changeVolume(Number(e.target.value))}
                title={`Volume ${vol}%`}
              />
            </div>

            <span className="lp-time" style={{ marginLeft: 6 }}>
              {fmtTime(mpvState.timeMs)} / {fmtTime(mpvState.durationMs)}
            </span>

            <div style={{ flex: 1 }} />

            {/* options cluster */}
            <PlayerSelect
              label="Subs"
              head="Subtitles"
              value={subMode}
              display={subMode === "loom" ? "Loom" : "Original"}
              options={subModeOptions}
              onChange={(v) => setSubMode(v as SubMode)}
              title="Loom captions, or original subtitles (Loom off)"
              onOpenChange={handleMenuOpen}
            />
            <PlayerSelect
              label="Video"
              head="Video language"
              value={targetId ?? ""}
              display={upper(targetLang)}
              options={videoOptions}
              onChange={(v) => chooseTargetId(v || null)}
              title="Video language (Loom captions)"
              onOpenChange={handleMenuOpen}
            />
            <PlayerSelect
              label="You"
              head="Your language"
              value={nativeId ?? ""}
              display={nativeTrack ? upper(nativeTrack.caption.languageCode) : "—"}
              options={youOptions}
              onChange={(v) => chooseNativeId(v || null)}
              title="Your language (Loom bottom line)"
              onOpenChange={handleMenuOpen}
            />
            {audioTracks.length > 1 && (
              <PlayerSelect
                label="Audio"
                head="Audio track"
                value={String(aid ?? "")}
                display={selAudio ? upper(selAudio.lang) || "Audio" : "Audio"}
                options={audioOptions}
                onChange={(v) => {
                  const n = Number(v);
                  setAid(n);
                  void setAudioTrack(n);
                }}
                title="Audio track"
                onOpenChange={handleMenuOpen}
              />
            )}
            <PlayerSelect
              value={String(nearestSpeed)}
              head="Speed"
              display={`${nearestSpeed}×`}
              options={speedOptions}
              onChange={(v) => {
                const n = Number(v);
                void setSpeed(n);
                showOsd(`${n}×`);
              }}
              title="Playback speed ( [ / ] )"
              onOpenChange={handleMenuOpen}
            />

            <IconButton
              onClick={cycleAbLoop}
              active={loopState > 0}
              title={
                loopState === 0
                  ? "A–B loop: set point A (l)"
                  : loopState === 1
                    ? "A–B loop: set point B (l)"
                    : "A–B loop: clear (l)"
              }
            >
              <LoopIcon />
            </IconButton>
            <IconButton onClick={() => void pickFile()} title="Open video…">
              <FolderIcon />
            </IconButton>
            <IconButton
              onClick={() => setShowSettings((v) => !v)}
              active={showSettings}
              title="Settings"
            >
              <GearIcon />
            </IconButton>
            <IconButton
              onClick={toggleFullscreen}
              title={fullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"}
            >
              {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
            </IconButton>
          </div>
        </div>
      )}

      {/* 6. Start screen (no media) — Open + drag-drop hint + recents. */}
      {!media && (
        <EmptyState
          onOpen={loadPath}
          onPick={() => void pickFile()}
          onRemove={() => setRecentsKey((k) => k + 1)}
          busy={busy}
          error={error}
          disabled={!attached}
          refreshKey={recentsKey}
        />
      )}

      {showSettings && (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 360,
            maxWidth: "92vw",
            overflowY: "auto",
            pointerEvents: "auto",
            background: "rgba(12,12,16,0.97)",
            borderLeft: "1px solid rgba(255,255,255,0.12)",
            padding: 12,
            boxShadow: "-8px 0 24px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}
          >
            <IconButton onClick={() => setShowSettings(false)} title="Close settings" size={30} iconSize={16}>
              <CloseIcon />
            </IconButton>
          </div>
          <SettingsPanel />
        </div>
      )}

      {card && !songActive && !loomOff && targetLang && (
        <div style={{ pointerEvents: "auto" }}>
          <DefinitionCard
            word={card.word}
            lemma={card.lemma}
            reading={card.reading}
            rect={card.rect}
            langCode={normalizeDefineSourceLang(targetLang)}
            glossLangOverride={glossOverride}
            onGlossLangChange={onGlossLangChange}
            onDismiss={() => setCard(null)}
          />
        </div>
      )}
    </div>
  );
}

