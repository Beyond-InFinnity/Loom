# app/memory_manager.py
"""Playwright memory management for long PGS rasterization sessions.

Monitors memory usage and render-time degradation to decide when to recycle
Playwright browser pages.  Recycling (close + reopen) releases leaked
Chromium process memory that accumulates during high-resolution screenshot
sequences.

The ``PlaywrightMemoryManager`` encapsulates all decision logic so the
render loop in rasterize.py stays clean.

Strategies
----------
A: fixed_100     — recycle every 100 frames, gc every 50
B: fixed_500     — recycle every 500 frames, gc at recycle
C: child_rss     — recycle when Playwright child-tree RSS > threshold
D: system_avail  — recycle when system available memory < threshold
E: render_time   — recycle when frame time > 3× rolling average
F: combined      — child RSS primary, render-time secondary, hard cap safety net
"""

from __future__ import annotations

import collections
import gc
import os
import time
from dataclasses import dataclass, field
from typing import Literal

StrategyName = Literal[
    'fixed_100', 'fixed_500',
    'child_rss', 'system_avail',
    'render_time', 'combined',
]


def get_browser_pid(browser) -> int | None:
    """Extract the Playwright Node.js server PID from a Browser object.

    Works with both sync and async Playwright Browser instances.
    Returns None if the PID cannot be determined.
    """
    try:
        return browser._impl_obj._connection._transport._proc.pid
    except (AttributeError, TypeError):
        return None


def _get_chromium_rss(browser_pid: int | None) -> int:
    """Sum RSS of the browser process tree (bytes).  Returns 0 on failure."""
    if browser_pid is None:
        return 0
    try:
        import psutil
        parent = psutil.Process(browser_pid)
        total = parent.memory_info().rss
        for child in parent.children(recursive=True):
            try:
                total += child.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return total
    except Exception:
        return 0


def _get_available_memory() -> int:
    """Return available system memory in bytes.  Returns 0 on failure."""
    try:
        import psutil
        return psutil.virtual_memory().available
    except Exception:
        return 0


def _get_total_memory() -> int:
    """Return total system memory in bytes."""
    try:
        import psutil
        return psutil.virtual_memory().total
    except Exception:
        return 16 * 1024**3  # assume 16 GB


@dataclass
class RecycleDecision:
    """Result of a should_recycle() check."""
    recycle: bool
    reason: str = ''
    do_gc: bool = False


class PlaywrightMemoryManager:
    """Decides when to recycle Playwright pages during PGS rendering.

    Usage::

        mgr = PlaywrightMemoryManager(strategy='combined', browser_pid=pid)
        for i, event in enumerate(events):
            t0 = time.monotonic()
            # ... render frame ...
            elapsed = time.monotonic() - t0
            decision = mgr.should_recycle(frame_index=i, render_time=elapsed)
            if decision.recycle:
                # ... close and reopen pages ...
                mgr.notify_recycled()
            if decision.do_gc:
                gc.collect()

    Parameters
    ----------
    strategy : StrategyName
        Which strategy to use.
    browser_pid : int | None
        PID of the Playwright/Chromium main process (for child_rss / combined).
    child_rss_threshold : int | None
        Bytes.  For ``child_rss`` strategy.  Default: 2 GB.
    system_avail_threshold_pct : float
        For ``system_avail`` strategy.  Recycle when available < this % of total.
    system_avail_threshold_abs : int
        Minimum absolute available bytes (floor for system_avail).
    render_time_multiplier : float
        For ``render_time`` / ``combined``.  Spike if frame > N× rolling avg.
    rolling_window : int
        Number of recent frames for rolling average.
    hard_cap_frames : int
        For ``combined``: unconditional recycle after this many frames since
        last recycle (belt-and-suspenders).
    warmup_frames : int
        For ``combined``: skip all checks for the first N frames.
    """

    def __init__(
        self,
        strategy: StrategyName = 'combined',
        browser_pid: int | None = None,
        child_rss_threshold: int | None = None,
        system_avail_threshold_pct: float = 0.15,
        system_avail_threshold_abs: int = 2 * 1024**3,
        render_time_multiplier: float = 3.0,
        rolling_window: int = 20,
        hard_cap_frames: int = 2000,
        warmup_frames: int = 50,
    ):
        self.strategy = strategy
        self.browser_pid = browser_pid

        # Strategy C: child RSS threshold
        if child_rss_threshold is not None:
            self._child_rss_threshold = child_rss_threshold
        elif strategy == 'combined':
            # Auto-derive: 50% of system RAM, capped at 4 GB
            total = _get_total_memory()
            self._child_rss_threshold = min(total // 2, 4 * 1024**3)
        else:
            self._child_rss_threshold = 2 * 1024**3  # 2 GB default

        # Strategy D: system available memory
        self._sys_avail_pct = system_avail_threshold_pct
        self._sys_avail_abs = system_avail_threshold_abs

        # Strategy E / F: render-time spike
        self._rt_multiplier = render_time_multiplier
        self._rolling_window = rolling_window
        self._render_times: collections.deque[float] = collections.deque(
            maxlen=rolling_window
        )

        # Strategy F: hard cap + warmup
        self._hard_cap = hard_cap_frames
        self._warmup = warmup_frames

        # Bookkeeping
        self._frames_since_recycle = 0
        self._total_frames = 0
        self._recycle_count = 0
        self._peak_child_rss = 0
        self._peak_python_rss = 0

    # ── Public API ────────────────────────────────────────────────────

    def should_recycle(
        self,
        frame_index: int,
        render_time: float = 0.0,
    ) -> RecycleDecision:
        """Check whether pages should be recycled after rendering a frame.

        Call this *after* each frame is rendered.

        Parameters
        ----------
        frame_index : int
            0-based global frame index.
        render_time : float
            Wall-clock seconds for the most recent frame render.
        """
        self._total_frames = frame_index + 1
        self._frames_since_recycle += 1
        self._render_times.append(render_time)

        # Track peak memory for reporting (every 10 frames to limit overhead)
        if self._total_frames % 10 == 0:
            self._update_peak_memory()

        dispatch = {
            'fixed_100': self._check_fixed_100,
            'fixed_500': self._check_fixed_500,
            'child_rss': self._check_child_rss,
            'system_avail': self._check_system_avail,
            'render_time': self._check_render_time,
            'combined': self._check_combined,
        }

        return dispatch[self.strategy](frame_index)

    def notify_recycled(self) -> None:
        """Call after pages have been recycled to reset internal counters."""
        self._frames_since_recycle = 0
        self._recycle_count += 1

    @property
    def recycle_count(self) -> int:
        return self._recycle_count

    @property
    def peak_child_rss_bytes(self) -> int:
        return self._peak_child_rss

    @property
    def peak_python_rss_bytes(self) -> int:
        return self._peak_python_rss

    # ── Strategy implementations ──────────────────────────────────────

    def _check_fixed_100(self, frame_index: int) -> RecycleDecision:
        """Strategy A: recycle every 100 frames, gc every 50."""
        if self._frames_since_recycle >= 100:
            return RecycleDecision(recycle=True, do_gc=True,
                                   reason='fixed_100: 100 frames')
        if self._frames_since_recycle % 50 == 0 and self._frames_since_recycle > 0:
            return RecycleDecision(recycle=False, do_gc=True,
                                   reason='fixed_100: gc at 50')
        return RecycleDecision(recycle=False)

    def _check_fixed_500(self, frame_index: int) -> RecycleDecision:
        """Strategy B: recycle every 500 frames, gc at recycle."""
        if self._frames_since_recycle >= 500:
            return RecycleDecision(recycle=True, do_gc=True,
                                   reason='fixed_500: 500 frames')
        return RecycleDecision(recycle=False)

    def _check_child_rss(self, frame_index: int) -> RecycleDecision:
        """Strategy C: recycle when child-tree RSS > threshold.

        Only queries psutil every 10 frames to minimize overhead.
        """
        if self._frames_since_recycle % 10 != 0:
            return RecycleDecision(recycle=False)
        rss = _get_chromium_rss(self.browser_pid)
        if rss > self._child_rss_threshold:
            return RecycleDecision(
                recycle=True, do_gc=True,
                reason=f'child_rss: {rss / 1024**3:.2f} GB > '
                       f'{self._child_rss_threshold / 1024**3:.2f} GB',
            )
        return RecycleDecision(recycle=False)

    def _check_system_avail(self, frame_index: int) -> RecycleDecision:
        """Strategy D: recycle when system available memory is low.

        Only queries psutil every 10 frames to minimize overhead.
        """
        if self._frames_since_recycle % 10 != 0:
            return RecycleDecision(recycle=False)
        avail = _get_available_memory()
        total = _get_total_memory()
        threshold = max(total * self._sys_avail_pct, self._sys_avail_abs)
        if avail < threshold:
            return RecycleDecision(
                recycle=True, do_gc=True,
                reason=f'system_avail: {avail / 1024**3:.2f} GB available '
                       f'< {threshold / 1024**3:.2f} GB threshold',
            )
        return RecycleDecision(recycle=False)

    def _check_render_time(self, frame_index: int) -> RecycleDecision:
        """Strategy E: recycle on render-time spike."""
        if len(self._render_times) < 5:
            return RecycleDecision(recycle=False)

        avg = sum(self._render_times) / len(self._render_times)
        latest = self._render_times[-1]

        if avg > 0 and latest > self._rt_multiplier * avg:
            return RecycleDecision(
                recycle=True, do_gc=True,
                reason=f'render_time: {latest:.3f}s > '
                       f'{self._rt_multiplier}× avg {avg:.3f}s',
            )
        return RecycleDecision(recycle=False)

    def _check_combined(self, frame_index: int) -> RecycleDecision:
        """Strategy F: child RSS + render-time spike + hard cap."""
        # Skip during warmup
        if self._total_frames <= self._warmup:
            return RecycleDecision(recycle=False)

        # Primary: child RSS (check every 10 frames)
        if self._frames_since_recycle % 10 == 0:
            rss = _get_chromium_rss(self.browser_pid)
            if rss > self._child_rss_threshold:
                return RecycleDecision(
                    recycle=True, do_gc=True,
                    reason=f'combined/rss: {rss / 1024**3:.2f} GB > '
                           f'{self._child_rss_threshold / 1024**3:.2f} GB',
                )

        # Secondary: render-time spike
        if len(self._render_times) >= 5:
            avg = sum(self._render_times) / len(self._render_times)
            latest = self._render_times[-1]
            if avg > 0 and latest > self._rt_multiplier * avg:
                return RecycleDecision(
                    recycle=True, do_gc=True,
                    reason=f'combined/time: {latest:.3f}s > '
                           f'{self._rt_multiplier}× avg {avg:.3f}s',
                )

        # Safety net: hard cap
        if self._frames_since_recycle >= self._hard_cap:
            return RecycleDecision(
                recycle=True, do_gc=True,
                reason=f'combined/cap: {self._hard_cap} frames',
            )

        return RecycleDecision(recycle=False)

    # ── Internal ──────────────────────────────────────────────────────

    def _update_peak_memory(self) -> None:
        """Track peak memory for reporting."""
        try:
            import psutil
            self._peak_python_rss = max(
                self._peak_python_rss,
                psutil.Process(os.getpid()).memory_info().rss,
            )
        except Exception:
            pass

        child_rss = _get_chromium_rss(self.browser_pid)
        self._peak_child_rss = max(self._peak_child_rss, child_rss)
