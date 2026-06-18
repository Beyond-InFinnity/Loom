# Loom Extension — UI / Defaults Overhaul (tracking doc)

> Running tracker for the settings-panel + defaults + per-language-control
> consistency pass that opened 2026-06-19, after the Netflix port's first
> pass landed. Connor enumerates observed issues; Claude runs the systematic
> audit and proposes fix directions; we converge here before touching code.

## Status (2026-06-19)

**All six overhaul substeps (5i-1 … 5i-6) shipped** + the C-7 prose fix. tsc
clean, 189/189 vitest, firefox-mv2 + chrome-mv3 build. Not yet committed; not yet
live-verified by Connor. **Open:** I-2 (Hindi romanization live test — needs a
prod run); palette/switch-color eyeballing; the settings-panel alt-orth **preview**
still visually shows Simplified below the reading (C-7 residue) — reconcile when
convenient.

## Governing principle

The engine (`loom_core` + `loom_api`) supports far more than the UI
**consistently exposes** — rich controls for some languages, nothing for
others, uneven defaults and labels. The fix direction is **simplify + make
uniform** (capability-driven exposure), **NOT add knobs**. A feature whose
backend is ✅ should surface the same way for *every* language that has it,
or not at all — never "CJK gets the picker, everyone else is silently
hardcoded to the default."

## Audit method (2026-06-19)

Two parallel read-only audits:
1. **Settings-panel inventory** — every control, its show/hide condition,
   storage key, and the code path for the two seeded issues.
2. **Engine capability matrix** — per-language ground truth from
   `lang-support.ts` vs `loom_core/romanize.py` + `styles.py`, flagging every
   mismatch between engine capability and UI exposure.

---

## Candidate issues

Status legend: **CONFIRMED** (root cause pinned in code) · **NEEDS LIVE TEST**
(hypothesis, needs a prod-API run) · **PROPOSAL** (design direction, not yet
agreed).

### I-1 — Phonetic-system picker is annotation-coupled; should be romanization-capability-driven · ✅ RESOLVED in 5i-3 · **highest-leverage**

**Observation (Connor):** No way to turn Thai paiboon/RTGS/IPA on or off.

**Root cause.** The picker (`PHONETIC_SYSTEM_OPTIONS`,
`settings-panel.tsx:1287-1291`) hardcodes **only the 3 Chinese options**
(pinyin/zhuyin/jyutping) and is rendered only when the track is
`annotatable` — i.e. `classifyLang(lang).processing === "annotate-romanize"`
(`settings-panel.tsx:1301-1303`, gate at 1329). That set is CJK + Korean only.
The stale comment at `settings-panel.tsx:1285` says Thai's systems are
"deferred until Thai annotation lands."

**Why the gate is wrong.** `phonetic_system` governs the **romanization
line**, not just ruby. The line is already fetched for every romanize-tier
language with `phonetic_system` plumbed end-to-end
(`build-map.ts:96` → `/romanize/batch` → `get_lang_config(code, phonetic_system=…)`,
`romanize.py:185`). The backend accepts multiple systems for several
non-CJK, **non-annotatable** languages:

| Lang | Backend systems (`romanize.py` / `styles.py`) | Has ruby? | Picker today |
|------|-----------------------------------------------|-----------|--------------|
| Thai (`th`) | `paiboon` (def) / `rtgs` / `ipa` | no | ❌ none |
| Arabic (`ar`) | `learner` (def) / `din` / `loose` | no | ❌ none |
| Persian (`fa`) | `learner` (def) / `dmg` | no | ❌ none |
| Urdu (`ur`) | `learner` (def) / `ala-lc` | no | ❌ none |
| Chinese | `pinyin` / `zhuyin` / `jyutping` | yes | ✅ (only this) |

Arabic is the proof the gate is mis-conceived: **no ruby, three line-systems,
no UI.** The picker should be driven by "does this language's romanizer expose
multiple systems," attached to the **Romanization** row (already shown for all
romanize-tier langs), with **language-specific** option labels — not the
single Chinese-only list bolted to the annotation row.

**Languages that correctly need NO picker** (single backend system — absence is
right): Korean, Cyrillic (all), Indic (all — IAST only), Hebrew.

**Fix direction (PROPOSAL).** Replace the hardcoded CJK-only
`PHONETIC_SYSTEM_OPTIONS` + `annotatable` gate with a small per-language
system map in `lang-support.ts` (mirrors `styles.py`; same pattern as the
existing hardcoded list, keeps Python as source of truth via a thin
transcription). Show the picker on the Romanization row iff that map has >1
entry for the target/native language. CJK keeps ruby+line coupling (one
picker drives both); Thai/Arabic/Persian/Urdu get a line-only picker.
Japanese long-vowel mode (below) folds into the same "capability-gated"
treatment.

---

### I-2 — Hindi romanization not appearing · NEEDS LIVE TEST

**Observation (Connor):** Hindi romanization "doesn't look plugged in."

**What's verified in code.** The path is structurally sound:
- `hi` → `Deva` → `indic` → `processing: "romanize"`
  (`lang-code.ts:111`, `lang-support.ts:91,111`).
- Romanize toggle renders and is active (not dimmed); **default ON** for target
  (`discover.ts:74`).
- Fetch gate passes (`discover.ts:747`: `romanize`-tier is allowed).
- `/romanize/batch` for a romanize-tier lang runs `romanize_func(text)` and
  reports `has_phonetic_layer=True` when the romanizer exists
  (`romanize.py:189-208`; `styles.py:423` `has_phonetic_layer = romanizer is not None`).
- Hindi's romanizer is built via aksharamukha (IAST), present on prod (Indic
  romanization is engine+API ✅ per CLAUDE.md). **Not installable to confirm
  locally** — this box lacks `aksharamukha`/`pythainlp`/`fugashi`/`pypinyin`;
  Arabic (pure-Python) resolves locally and returns `has_phonetic_layer=True`,
  confirming the route shape.

**Ranked hypotheses for the live drop-out** (most→least likely):
1. **Lang-code the extension actually sends.** Confirm the Hindi track's
   `languageCode` reaches `/romanize/batch` as `hi` (not `hi-IN`/`hin`/a tlang
   override). `get_lang_config` must resolve it to the Indic romanizer.
2. **Render, not fetch.** Confirm the overlay renders the romanization line for
   a `romanize`-tier (non-CJK) target the same way it does for Cyrillic/Thai —
   i.e. the line slot isn't gated on `annotate-romanize` anywhere downstream.
3. **Genuinely empty result** — `has_phonetic_layer=false` from prod (would
   contradict the matrix; least likely).

**Next action.** Live test on a Hindi title with the dev build against the prod
API; read the `[Loom Romanize]` devlog. The log distinguishes the three:
`build-map.ts:128` ("no phonetic layer") vs `:105` (HTTP error) vs
`:147` (`got_romanized=N`). One run localizes it.

---

### I-3 — Japanese long-vowel mode is a global, always-visible control · PROPOSAL

`settings-panel.tsx:456-459,1408-1429`: the macrons/doubled/unmarked dropdown
is shown unconditionally and is global, even though the backend ignores it for
every non-Japanese language. Same uneven-exposure smell as I-1 in reverse: a
language-specific control shown to everyone. Fold into I-1's capability-gating
— show it only when a Japanese track is the target/native.

---

### I-4 — Hint-text accuracy · CONFIRMED (minor)

- Annotation hint "Only CJK + Korean supported in this build"
  (`settings-panel.tsx:436-440`) is **accurate** for the extension — ruby
  layout assumes CJK glyph widths (`annotated-text.tsx`), so Thai/Indic ruby is
  a real deferral, not a bug. (The engine audit's "Thai annotation already
  landed" refers to backend capability, not extension ruby.) Leave as-is.
- Romanization hint claims Indic coverage (`settings-panel.tsx:460-465`) with
  no "may be unavailable" caveat. Accurate **if** I-2 resolves to working;
  revisit after the live test.
- Preset placeholder lists "Chinese, Japanese, Korean, Thai, or Russian"
  (`settings-panel.tsx:1766`) — verify against the live `/styles/presets`
  catalog; update if stale.

---

## Connor's observed issues (2026-06-19, batch 1)

> "There's more, but those are the obvious things that stand out for now."
> More to come — this is mid-enumeration.

### C-1 — Consolidate all per-line settings into the 4 line-boxes · STRUCTURAL

Every styling/behavior control for a given line should live inside that line's
box. Four boxes, period: **Bottom · Top · Annotation · Romanization**. Today
the controls are scattered across separate sections (Annotations toggle row,
Romanization toggle row, Alternate-orthography section, Styles section with the
per-layer color/font cards, Position section). Roll them all into the four
cards.

- **Maps to:** a full re-layout of `settings-panel.tsx`. The per-layer style
  cards already exist (`StyleBlock`-style, lines ~491-577); the work is moving
  the annotation/romanize toggles, phonetic-system picker, alt-orth controls,
  opacity, and single-line toggle *into* the relevant card.
- **Open question (proposing a default, react if wrong):** what stays OUTSIDE
  the 4 boxes? Proposed top "Sources & layout" strip: native-lang pref, the
  target/native **track pickers** + translate-to, **presets**, and the
  **position** picker (since position is a cross-line layout concern). The 4
  cards hold everything visual/phonetic. Alt-orth controls live in the **Top**
  card (they annotate the top text); the simplified-char color + its tiers go
  there too.

### C-2 — Language-specific controls appear only for that language · = I-1 + I-3

Confirms the audit's core theme. Japanese long-vowel (Hepburn) mode shows only
when **Japanese** is the processed language; alternate-orthography shows only
when **zh-Hant** (Traditional family) is current. Generalize: every
language-specific affordance is capability-gated on the selected track's
language. Folds together with **I-1** (phonetic-system picker → capability-
driven) and **I-3** (long-vowel mode → Japanese-only).

### C-3 — Default colors (pastel palette) · CONFIRMED scope, palette TBD

All-white is overwhelming/uninformative for a new user. Default convention:
**pastels** (look good together, always). Per-line defaults:

| Slot | Connor's spec | Proposed hex (react/adjust) |
|------|---------------|------------------------------|
| Bottom | custard/cream (NOT pastel) | `#FBF3C4` |
| Top | purple | `#BDB2FF` |
| Annotation | red | `#FFADAD` |
| Romanization | green | `#CAFFBF` |
| Alt-orth **1:1 / distinct** | blue | `#A0C4FF` |
| Alt-orth **merged** | yellow | `#FDFFB6` |
| Alt-orth **simplified char** | purple (= Top by default) | `#BDB2FF` |

- **Simplified-char "same as Top" checkbox**, checked by default — when on, the
  simplified-char glyph color tracks the Top color. Maps to: `variantColor`
  (under-ruby / simplified glyph) gains a `*_sameAsTop` companion flag;
  distinct→`variantCleanColor`, merged→`variantCollapseColor`.
- **Maps to:** the `caption-context.tsx` default constants (currently `#ffffff`
  everywhere; alt-orth currently `#5cffff`/`#ffcc5c`). New-install defaults only
  — don't stomp a user's saved customization (need a default-vs-touched guard or
  accept that it only affects fresh installs).
- **Note:** merged-yellow `#FDFFB6` sits near bottom-custard `#FBF3C4`; flag if
  they read too close in practice.

### C-4 — Toggle UX: switch (dot-in-pill), not a press-to-flip button · CONFIRMED

Replace the on/off "button that says ON" with a **switch**: dot left = off, dot
right = on. **Desaturated greyed-gold when off, neon purple when on.** Applies
to the annotation + romanization toggles (and the other booleans, for
consistency).

- **Bottom-line annotation toggle moves into Advanced** — accessible but an edge
  case, shouldn't sit in the primary flow.
- **Maps to:** new shared `Switch` component; replace the toggle-button JSX in
  `AnnotateRow`/`RomanizeRow` and the boolean rows. Neon-purple / greyed-gold to
  be pinned as tokens (proposed: on `#B026FF`-ish neon purple, off a muted
  `#9A8C5A` gold — react/adjust).

### C-5 — Per-line opacity, with linked Top-group · NEW

Each line needs an **opacity** control. **Bottom opacity is independent.**
**Top + Annotation + Romanization + Alt-orth share one opacity by default**
(adjust together). An **Advanced checkbox on Top (checked by default) = "link
opacity"**; unchecking it lets each of the top-group sub-lines take its own
opacity.

- **Maps to:** alpha state partly exists (`bottomAlpha`, `topAlpha`;
  annotation/romanization currently *inherit* alpha from parent). Formalize a
  `topGroupOpacityLinked` flag (default true) driving whether one slider writes
  all four top-group alphas or each is independent. Surface a Bottom opacity
  slider + a Top opacity slider in the primary card (not just Advanced — C-5
  implies opacity is a first-class per-line control).

### C-6 — "Render multi-line event as single line" toggle · ❌ REVERTED

Shipped in 5i-6, then **removed** at Connor's request (2026-06-19) — confusing
sitting next to the line on/off, and a no-op on single-line cues so it read as
broken. Fully ripped out (UI + context state + overlay `collapseNewlines`). The
real need was the per-line enable (C-8), not line-collapsing. Easy to resurrect
if multi-line annotated-CJK clutter ever genuinely bites.

### C-6 (original) — "Render multi-line event as single line" toggle

A per-side toggle (Top and Bottom, Bottom's children follow) to collapse
multi-line subtitle events onto one line — strip carriage returns *within a
single event*. Multi-line annotated CJK gets "insanely cluttered."

- **Maps to:** a render-time transform on the caption text before layout
  (replace intra-event `\n` / `<br>` with a space/separator), gated by a new
  per-side `collapseLines` setting. Lives in the overlay render path, not the
  fetch path. Bottom children = annotation/romanization tied to the Bottom side
  follow the Bottom toggle.

### C-7 — Alt-orth renders ABOVE, not below (description fix only) · DONE (prose) + preview divergence flagged

The Simplified auxiliary ruby floats **above** the reading/annotation line (the
liked behavior; `annotated-text.tsx:39-43` — Firefox forces the outer rt
`over`). UI strings + my CLAUDE.md tripwire wrongly said "below." **Language
coding unchanged — descriptions only.** Fixed: `settings-panel.tsx` toggle
label (`show … above`) + hint ("floats a small auxiliary ruby … above the
reading"); CLAUDE.md nested-ruby tripwire reworded. Store copy
(`SUBMISSION_0.1.7.md`) had no position claim — nothing to fix there.

**Open residue:** the settings-panel **preview** still uses flat single-rt
rubies and so VISUALLY shows Simplified *below* the reading — contradicts the
live overlay. Reconcile the preview (or relabel it) during **5i-4** when the
alt-orth controls move into the Top card.

---

## Proposed execution sequencing (substeps — for sign-off)

Paced as substeps per the usual rhythm. Order optimizes quick visual wins first,
the big structural re-layout in the middle, behavior last:

1. **5i-1 Pastel defaults + simplified="same as Top" checkbox** (C-3). ✅ DONE.
   Defaults (fresh-install only): Bottom `#fbf3c4` custard · Top `#bdb2ff` ·
   Annotation `#ffadad` · Romanization `#caffbf` · alt-orth distinct `#a0c4ff` ·
   merged `#fdffb6` · Simplified `#bdb2ff` (= Top). New
   `variantColorSameAsTop` state (default on, persisted) resolved in
   `caption-overlay.tsx`; settings row relabeled "Simplified char" + a "same as
   Top" toggle that locks the swatch to the Top color. tsc clean, 189/189 green,
   firefox-mv2 builds.
2. **5i-2 Switch component** (C-4) + move Bottom annotation to Advanced. ✅ DONE.
   New `Switch` (dot-in-pill: greyed-gold `#7d7048` off → neon-purple `#b026ff`
   on, sliding white dot, `role="switch"`) replaces all 5 On/Off text buttons
   (annotate/romanize target rows, alt-orth highlight, simplified same-as-Top,
   variant toggle). Removed the dead `annotateToggleStyle`. New
   `AdvancedDisclosure` wrapper (reuses `advancedToggleStyle`/`advancedBlockStyle`)
   tucks the **Native** annotation row under a collapsed "Native annotations ▾".
   tsc clean, 189/189, firefox-mv2 builds.
3. **5i-3 Capability-gating** (C-2 / I-1 / I-3). ✅ DONE. New
   `phoneticSystemsFor(code)` in `lang-support.ts` (mirrors `romanize.py`):
   Chinese pinyin/zhuyin/jyutping · Thai paiboon/rtgs/ipa · Arabic
   learner/din/loose · Persian learner/dmg · Urdu learner/ala-lc · everyone else
   `[]`. New `PhoneticSystemRow` (renders only when >1 system) replaces the
   CJK-only picker bolted to `AnnotateRow`; lives in the Romanization section,
   wired to the existing `targetPhoneticSystem`/`setTargetPhoneticSystem` (which
   already drive the romanize line — `discover.ts:703,772`). Long-vowel row now
   gated to a Japanese track present; `VariantSection` returns null unless a
   selected track has an orthography variant (zh-Hant family). tsc clean,
   189/189, firefox-mv2 builds. **Resolves I-1 + the Thai-paiboon issue.**
4. **5i-4 Panel consolidation** into 4 line-cards (C-1). ✅ DONE. `LayerStyleBlock`
   gained a `children` slot (rendered under the card header). The Annotations /
   Romanization / Alternate-orthography sections were dissolved and folded INTO
   the relevant card: **Bottom** (styling) · **Top** (styling + nested
   `VariantSection` alt-orth) · **Annotation** (target toggle + native-advanced +
   styling) · **Romanization** (target toggle + phonetic-system + long-vowel +
   native-advanced + styling). Sources/layout (native-lang, track pickers,
   position) + a "Color presets" box sit above the four cards. Native
   romanization also moved under an Advanced disclosure. tsc clean, 189/189,
   firefox-mv2 builds.
5. **5i-5 Per-line opacity + linked Top-group** (C-5). ✅ DONE. Opacity is now a
   first-class slider in each card (`LayerStyleBlock` `opacity` prop), no longer
   buried in Advanced. New `topGroupOpacityLinked` state (default on) + a "Link
   opacity" `Switch` in the **Top** card's Advanced. Overlay resolves effective
   alpha: linked → Top alpha drives Top + Annotation + Romanization + alt-orth
   (annotation/variant colors now alpha-applied via `hexToRgba`, new
   `romanizationAlpha` layer field); unlinked → Annotation + Romanization show
   their own opacity sliders. Bottom is always independent; its children follow
   `bottomAlpha`. tsc clean, 189/189, firefox-mv2 builds.
6. **5i-6 Single-line collapse** toggle (C-6). ❌ SHIPPED THEN REVERTED — see C-6
   above. Superseded by the per-line enable toggles (C-8). Original notes:
   Per-side
   `topCollapseLines` / `bottomCollapseLines` state (default off, persisted) +
   a "Collapse to one line" `Switch` in the Bottom + Top cards. Overlay collapses
   `\n` → space for DISPLAY only (`collapseNewlines`), AFTER the annotation /
   romanization map lookups (which stay keyed on the original text, so spans +
   romanization still match — `\n`→space is a 1:1 char swap). Romanization line
   collapses with its side. tsc clean, 189/189, firefox-mv2 + chrome-mv3 build.
7. **I-2 Hindi romanization** — live prod test (Connor-run), separate track.

(3 and 4 interact — gating decides *whether* a control shows; consolidation
decides *where*. May merge them. Open to reordering.)

---

---

### C-8 — Per-line master enable for Bottom + Top · ✅ DONE

Connor (testing 5i-1…5i-6): Bottom + Top had no on/off — only Annotation /
Romanization did. Add a master enable per line so Loom doubles as a subtitle
customizer (e.g. foreign + furigana, no native line). New `topLineEnabled` /
`bottomLineEnabled` state (default ON, persisted) + a "Show Top line" / "Show
Bottom line" `Switch` as the first row of each card (generalized `CollapseLinesRow`
→ `ToggleRow`). Overlay: a disabled line contributes no text, so its whole layer
(base + annotation + romanization + alt-orth) is skipped AND its slot isn't
reserved (no gap). tsc clean, 189/189, dev build rebuilt for live test.

---

## Decisions log

- 2026-06-19 — Resolved the audit disagreement on the Thai/Indic picker:
  `phonetic_system` drives the romanization **line**, not just ruby, so the
  picker belongs on the Romanization row and must be capability-driven
  (I-1). Annotation ruby for Thai/Indic stays deferred (CJK glyph-width
  assumption is real).
</content>
</invoke>
