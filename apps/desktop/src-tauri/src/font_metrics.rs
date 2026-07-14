// Font advance-ratio probe for song furigana (Loom Player-local).
//
// Furigana is placed by absolute \pos in libass coordinates, so it needs the
// base lyric glyph advance — which is font-dependent.  Rather than PIN every
// furigana line to a known font (which throws away the fansub's OP typeface),
// we read the ACTUAL font's metrics and compute libass's advance ratio:
//
//     ratio = fullwidth_advance / (winAscent + winDescent)     [VSFilter / libass
//           = unitsPerEm        / (winAscent + winDescent)      convention: the
//                                                                nominal font size
//                                                                maps to win asc+desc]
//
// A full-width CJK ideograph advances exactly one em by design, so unitsPerEm
// IS the advance — no cmap/hmtx needed, just `head` (upm) + `OS/2` (win metrics).
// The frontend multiplies fontsize × ratio to lay furigana over the kanji in the
// original font — no pin.  When a font can't be resolved the family is simply
// omitted from the result and the caller keeps the Noto pin (which is also
// exactly when the base is falling back to Noto anyway, so the pin matches).
//
// Font resolution mirrors libass on Linux: embedded MKV attachments first
// (extracted via ffmpeg — the sidecar already depends on ffmpeg), then
// fontconfig (`fc-match`, lang-filtered so a CJK-covering face is chosen exactly
// as libass's per-glyph fallback would be).  X11/Linux only, like the rest of
// the Player.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// libass advance ratio for one font file, plus the family names it declares
/// (for matching) and whether it actually covers CJK.
struct FontInfo {
    families: Vec<String>,
    ratio: f64,
    has_cjk: bool,
}

/// Compute the libass advance ratio + family names from raw font bytes.  For a
/// .ttc collection, face 0's win metrics + upm are used (CJK faces in one
/// collection share vertical metrics), but names are gathered across all faces.
fn read_font(data: &[u8]) -> Option<FontInfo> {
    let count = ttf_parser::fonts_in_collection(data).unwrap_or(1).max(1);
    let face0 = ttf_parser::Face::parse(data, 0).ok()?;
    let upm = face0.units_per_em() as f64;
    let os2 = face0.tables().os2?;
    // Total em height = |winAscent| + |winDescent|.  ttf-parser reports the
    // descender as a signed (negative) value, but the raw OS/2 usWinDescent is
    // an unsigned magnitude — take abs() of both so the sum is version-agnostic.
    let denom = (os2.windows_ascender().unsigned_abs() as f64)
        + (os2.windows_descender().unsigned_abs() as f64);
    if denom <= 0.0 || upm <= 0.0 {
        return None;
    }
    let ratio = upm / denom;

    let mut families: Vec<String> = Vec::new();
    let mut has_cjk = false;
    for i in 0..count {
        let Ok(face) = ttf_parser::Face::parse(data, i) else {
            continue;
        };
        for name in face.names() {
            // nameID 1 = Family, 16 = Typographic Family.
            if name.name_id == 1 || name.name_id == 16 {
                if let Some(s) = name.to_string() {
                    if !families.iter().any(|f| f.eq_ignore_ascii_case(&s)) {
                        families.push(s);
                    }
                }
            }
        }
        if face.glyph_index('\u{6C38}').is_some() // 永
            || face.glyph_index('\u{4E00}').is_some() // 一
            || face.glyph_index('\u{56FD}').is_some() // 国
        {
            has_cjk = true;
        }
    }
    Some(FontInfo {
        families,
        ratio,
        has_cjk,
    })
}

/// Stable temp dir for a video's dumped font attachments (cached per path).
fn attach_dir(video: &str) -> PathBuf {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    video.hash(&mut h);
    std::env::temp_dir().join(format!("loom-fonts-{:x}", h.finish()))
}

/// Run a command but never block longer than `secs` (poll + kill).  Insurance
/// so a pathological file can't peg the machine even if ffmpeg misbehaves.
fn run_bounded(mut cmd: Command, secs: u64) {
    let Ok(mut child) = cmd.spawn() else {
        return;
    };
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed().as_secs() >= secs {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            Err(_) => break,
        }
    }
}

/// Dump the video's embedded font attachments once (cached).  ffmpeg writes each
/// attachment stream to its filename tag in the working directory.
///
/// CRITICAL: NO output file / `-f null` — that would make ffmpeg DECODE THE
/// ENTIRE VIDEO just to reach EOF (minutes of full-frame HEVC decode on a
/// feature-length REMUX, pegging the machine).  Attachments live in the
/// container header, so a bare `-dump_attachment` reads them during demux setup
/// and exits (with a harmless "no output file" error) in ~0.1s regardless of
/// file size or codec.
fn ensure_attachments(video: &str) -> PathBuf {
    let dir = attach_dir(video);
    let done = dir.join(".loom-done");
    if done.exists() {
        return dir;
    }
    let _ = std::fs::create_dir_all(&dir);
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-nostdin", "-y", "-dump_attachment:t", "", "-i", video])
        .current_dir(&dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    run_bounded(cmd, 10);
    let _ = std::fs::write(&done, b"");
    dir
}

fn is_font_file(p: &std::path::Path) -> bool {
    p.extension()
        .and_then(|s| s.to_str())
        .map(|x| {
            let x = x.to_ascii_lowercase();
            x == "ttf" || x == "otf" || x == "ttc" || x == "otc"
        })
        .unwrap_or(false)
}

/// fontconfig resolution, lang-filtered — returns the file libass would pick for
/// this family when covering `lang` (so an unknown/Latin family resolves to the
/// same CJK fallback libass uses).
fn fc_match(family: &str, lang: &str) -> Option<PathBuf> {
    let l = if lang.is_empty() { "ja" } else { lang };
    let query = format!("{}:lang={}", family, l);
    let out = Command::new("fc-match")
        .args(["--format=%{file}", &query])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// For each requested font family, the libass advance ratio of the font that
/// actually renders it (embedded attachment → fontconfig).  Families that can't
/// be resolved (or don't cover CJK) are omitted → the caller keeps the Noto pin.
#[tauri::command]
pub fn player_font_advance_ratios(
    families: Vec<String>,
    video_path: String,
    lang: String,
) -> HashMap<String, f64> {
    let mut out = HashMap::new();

    // 1. Index the video's embedded font attachments.
    let mut attachments: Vec<FontInfo> = Vec::new();
    if !video_path.is_empty() {
        let dir = ensure_attachments(&video_path);
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if is_font_file(&p) {
                    if let Ok(data) = std::fs::read(&p) {
                        if let Some(fi) = read_font(&data) {
                            attachments.push(fi);
                        }
                    }
                }
            }
        }
    }

    // 2. Resolve each requested family, attachments first (as libass does).
    for fam in families {
        if let Some(fi) = attachments
            .iter()
            .find(|fi| fi.has_cjk && fi.families.iter().any(|f| f.eq_ignore_ascii_case(&fam)))
        {
            out.insert(fam, fi.ratio);
            continue;
        }
        if let Some(path) = fc_match(&fam, &lang) {
            if let Ok(data) = std::fs::read(&path) {
                if let Some(fi) = read_font(&data) {
                    if fi.has_cjk {
                        out.insert(fam, fi.ratio);
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::read_font;

    // Verifies the metric formula reproduces the values calibrated against
    // libass (ffmpeg `ass` filter) — Sans 0.6906, Serif 0.6959 — and that the
    // two DIFFERENT-metric fonts yield DIFFERENT ratios (the whole point of
    // reading the real font).  Skipped when the system Noto CJK isn't present.
    fn check(path: &str, family: &str, expected: f64) {
        let Ok(data) = std::fs::read(path) else {
            eprintln!("skip: {path} not present");
            return;
        };
        let fi = read_font(&data).expect("read_font");
        assert!(
            fi.families.iter().any(|f| f.eq_ignore_ascii_case(family)),
            "family {family} not among {:?}",
            fi.families
        );
        assert!(fi.has_cjk, "{family} should cover CJK");
        assert!(
            (fi.ratio - expected).abs() < 0.001,
            "{family}: ratio {} != {expected}",
            fi.ratio
        );
    }

    #[test]
    fn noto_cjk_ratios() {
        check(
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "Noto Sans CJK JP",
            0.6906,
        );
        check(
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
            "Noto Serif CJK JP",
            0.6959,
        );
    }
}
