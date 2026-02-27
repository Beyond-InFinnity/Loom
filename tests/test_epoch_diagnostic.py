"""Diagnostic test for PGS epoch management.

Generates a realistic sequence of abutting 2-object display sets with
alternating top text and constant bottom text, writes to .sup, then
parses the raw binary to check every known flicker source:

1. PDS scope — does Normal send partial palette (buggy decoder flash)?
2. Timing gaps — clear-to-show gaps that produce blank frames
3. Coordinate drift — unchanged object position shifts between ES/Normal
4. Composition state trace — every display set type with timing
5. Palette version — does decoder ignore PDS with stale version?
"""

import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from PIL import Image
from app.sup_writer import DisplaySet, SupWriter


# ── Binary parser ────────────────────────────────────────────────────

_SEG_PCS = 0x16
_SEG_WDS = 0x17
_SEG_PDS = 0x14
_SEG_ODS = 0x15
_SEG_END = 0x80

_COMP_STATE_NAMES = {0x80: 'ES', 0x40: 'AP', 0x00: 'Normal'}


def _parse_display_sets(raw):
    """Parse raw .sup binary into a list of display set dicts."""
    pos = 0
    segments = []
    while pos + 13 <= len(raw):
        magic = raw[pos:pos+2]
        if magic != b'PG':
            break
        pts = struct.unpack_from('>I', raw, pos + 2)[0]
        seg_type = raw[pos + 10]
        seg_size = struct.unpack_from('>H', raw, pos + 11)[0]
        seg_data = raw[pos + 13: pos + 13 + seg_size]
        segments.append({
            'type': seg_type, 'pts': pts,
            'size': seg_size, 'data': seg_data,
        })
        pos += 13 + seg_size

    # Group into display sets (PCS starts each)
    display_sets = []
    current = None
    for seg in segments:
        if seg['type'] == _SEG_PCS:
            if current is not None:
                display_sets.append(current)
            pcs = seg['data']
            comp_state = pcs[7] if len(pcs) > 7 else 0
            num_objects = pcs[10] if len(pcs) > 10 else 0
            pal_update = pcs[8] if len(pcs) > 8 else 0
            pal_id = pcs[9] if len(pcs) > 9 else 0

            # Parse composition objects from PCS
            obj_entries = []
            offset = 11
            for _ in range(num_objects):
                if offset + 8 <= len(pcs):
                    obj_id = struct.unpack_from('>H', pcs, offset)[0]
                    win_id = pcs[offset + 2]
                    crop_flag = pcs[offset + 3]
                    obj_x = struct.unpack_from('>H', pcs, offset + 4)[0]
                    obj_y = struct.unpack_from('>H', pcs, offset + 6)[0]
                    obj_entries.append({
                        'obj_id': obj_id, 'win_id': win_id,
                        'x': obj_x, 'y': obj_y,
                    })
                    offset += 8

            current = {
                'pts': seg['pts'],
                'pts_ms': seg['pts'] / 90.0,
                'comp_state': comp_state,
                'comp_state_name': _COMP_STATE_NAMES.get(comp_state, f'0x{comp_state:02X}'),
                'num_objects': num_objects,
                'pal_update': pal_update,
                'pal_id': pal_id,
                'objects': obj_entries,
                'pds_entries': 0,
                'pds_pal_version': -1,
                'ods_count': 0,
                'ods_object_ids': [],
                'has_wds': False,
                'seg_types': [seg['type']],
            }
        elif current is not None:
            current['seg_types'].append(seg['type'])
            if seg['type'] == _SEG_PDS:
                pds = seg['data']
                current['pds_pal_version'] = pds[1] if len(pds) > 1 else -1
                # Count entries: (size - 2) / 5  (2 bytes header, 5 bytes per entry)
                current['pds_entries'] = (len(pds) - 2) // 5
            elif seg['type'] == _SEG_ODS:
                current['ods_count'] += 1
                if len(seg['data']) >= 2:
                    ods_obj_id = struct.unpack_from('>H', seg['data'], 0)[0]
                    if ods_obj_id not in current['ods_object_ids']:
                        current['ods_object_ids'].append(ods_obj_id)
            elif seg['type'] == _SEG_WDS:
                current['has_wds'] = True

    if current is not None:
        display_sets.append(current)

    return display_sets


# ── Diagnostic helpers ───────────────────────────────────────────────

def _make_region_ds(start_ms, end_ms, top_img, bot_img, top_x, top_y, bot_x, bot_y):
    """Create a DisplaySet + regions list."""
    ds = DisplaySet(
        start_ms=start_ms, end_ms=end_ms,
        image=top_img, x=top_x, y=top_y,
        canvas_width=1920, canvas_height=1080,
    )
    regions = [(top_img, top_x, top_y), (bot_img, bot_x, bot_y)]
    return ds, regions


# ── Main diagnostic test ─────────────────────────────────────────────

def test_epoch_diagnostic_trace():
    """Generate 20 abutting events, dump full diagnostic trace."""
    # Constant bottom image (same every frame)
    bot_img = Image.new('RGBA', (300, 40), (255, 255, 0, 255))

    events = []
    for i in range(20):
        start = 1000 + i * 2000
        end = start + 2000
        # Alternate top text colors (simulates different subtitle lines)
        r = (i * 37) % 256
        g = (i * 73) % 256
        top_img = Image.new('RGBA', (250, 50), (r, g, 100, 255))
        top_key = (f'top_v{i}',)
        bot_key = ('bottom_constant',)
        events.append((start, end, top_img, top_key, bot_key))

    with tempfile.NamedTemporaryFile(suffix='.sup', delete=False) as f:
        tmp_path = f.name

    try:
        writer = SupWriter(tmp_path, 1920, 1080)
        for start, end, top_img, top_key, bot_key in events:
            ds, regions = _make_region_ds(
                start, end, top_img, bot_img,
                top_x=100, top_y=50, bot_x=120, bot_y=900,
            )
            writer.write(ds, extra_regions=regions,
                         region_content_keys=[top_key, bot_key])
        writer.close()

        # Parse binary
        with open(tmp_path, 'rb') as f:
            raw = f.read()
        ds_list = _parse_display_sets(raw)

        # ── Trace every display set ──────────────────────────────────
        print("\n" + "=" * 80)
        print("EPOCH DIAGNOSTIC TRACE")
        print("=" * 80)

        issues_found = []

        prev_show_ds = None
        for n, d in enumerate(ds_list):
            is_show = d['num_objects'] > 0
            is_clear = d['num_objects'] == 0 and d['pts'] > 0
            ds_label = "Show" if is_show else ("Clear" if is_clear else "Anchor")

            # Build objects description
            if is_show:
                obj_desc = ",".join(str(o['obj_id']) for o in d['objects'])
            else:
                obj_desc = "none"

            # Determine what changed (for shows)
            content_changed = ""
            if is_show and prev_show_ds is not None:
                prev_objs = {o['obj_id']: o for o in prev_show_ds['objects']}
                curr_objs = {o['obj_id']: o for o in d['objects']}
                changed_ids = d.get('ods_object_ids', [])
                if changed_ids:
                    names = []
                    for oid in changed_ids:
                        names.append(f"obj{oid}")
                    content_changed = "+".join(names)
                else:
                    content_changed = "none(skip?)"

            line = (
                f"[DS {n:3d}] type={d['comp_state_name']:6s} "
                f"pts={d['pts_ms']:8.1f}ms "
                f"objects={obj_desc:8s} "
            )
            if is_show:
                line += (
                    f"PDS_entries={d['pds_entries']:3d} "
                    f"PDS_ver={d['pds_pal_version']} "
                    f"ODS_count={d['ods_count']} "
                    f"ODS_objs={d['ods_object_ids']} "
                    f"WDS={'Y' if d['has_wds'] else 'N'} "
                    f"changed={content_changed}"
                )
            print(line)

            if is_show:
                prev_show_ds = d

        # ── CHECK 1: PDS scope in Normal display sets ────────────────
        print("\n" + "-" * 80)
        print("CHECK 1: PDS scope in Normal display sets")
        print("-" * 80)
        normal_ds = [d for d in ds_list if d['comp_state_name'] == 'Normal']
        es_ds = [d for d in ds_list if d['comp_state_name'] == 'ES' and d['num_objects'] > 0]

        if es_ds:
            es_pal_count = es_ds[0]['pds_entries']
            print(f"  Epoch Start PDS entries: {es_pal_count}")

        for i, nd in enumerate(normal_ds):
            print(f"  Normal #{i}: PDS_entries={nd['pds_entries']} "
                  f"PDS_ver={nd['pds_pal_version']} "
                  f"ODS_objs={nd['ods_object_ids']}")
            if es_ds and nd['pds_entries'] < es_ds[0]['pds_entries']:
                issue = (f"  *** ISSUE: Normal #{i} has {nd['pds_entries']} PDS entries "
                         f"vs {es_pal_count} in ES. Buggy decoders will flash "
                         f"the unchanged object (missing palette entries).")
                print(issue)
                issues_found.append(f"PDS partial in Normal #{i}")

        # ── CHECK 2: Timing gaps (clear→show) ───────────────────────
        print("\n" + "-" * 80)
        print("CHECK 2: Timing gaps between display sets")
        print("-" * 80)
        for i in range(len(ds_list) - 1):
            curr = ds_list[i]
            nxt = ds_list[i + 1]
            gap_ms = (nxt['pts'] - curr['pts']) / 90.0

            is_clear_to_show = (curr['num_objects'] == 0 and nxt['num_objects'] > 0
                                and curr['pts'] > 0)
            is_show_to_show = (curr['num_objects'] > 0 and nxt['num_objects'] > 0)

            if is_clear_to_show:
                print(f"  Clear→Show gap: {gap_ms:.1f}ms "
                      f"(clear@{curr['pts_ms']:.1f} → show@{nxt['pts_ms']:.1f})")
                if gap_ms > 30:
                    issue = f"  *** ISSUE: {gap_ms:.1f}ms gap → visible blank frame"
                    print(issue)
                    issues_found.append(f"Gap {gap_ms:.0f}ms at DS {i}")
            elif is_show_to_show:
                print(f"  Show→Show (abutting, no clear): gap={gap_ms:.1f}ms "
                      f"(@{curr['pts_ms']:.1f} → @{nxt['pts_ms']:.1f})")

        # ── CHECK 3: Coordinate drift on unchanged objects ───────────
        print("\n" + "-" * 80)
        print("CHECK 3: Coordinate stability for unchanged objects")
        print("-" * 80)
        show_ds = [d for d in ds_list if d['num_objects'] > 0]
        for i in range(1, len(show_ds)):
            prev = show_ds[i - 1]
            curr = show_ds[i]

            # Only check within same epoch (Normal/AP after ES)
            if curr['comp_state'] == 0x80:
                continue  # New epoch, coords reset

            for obj in curr['objects']:
                oid = obj['obj_id']
                # Find same object in previous show
                prev_obj = next((o for o in prev['objects'] if o['obj_id'] == oid), None)
                if prev_obj is None:
                    continue
                dx = obj['x'] - prev_obj['x']
                dy = obj['y'] - prev_obj['y']
                is_changed = oid in curr.get('ods_object_ids', [])
                if (dx != 0 or dy != 0) and not is_changed:
                    issue = (f"  *** ISSUE: obj{oid} UNCHANGED but coords shifted: "
                             f"({prev_obj['x']},{prev_obj['y']}) → "
                             f"({obj['x']},{obj['y']}) "
                             f"delta=({dx},{dy}) at pts={curr['pts_ms']:.1f}ms")
                    print(issue)
                    issues_found.append(f"Coord drift obj{oid} at {curr['pts_ms']:.0f}ms")
                elif dx == 0 and dy == 0 and not is_changed:
                    pass  # stable, good
                else:
                    print(f"  obj{oid} changed+moved: "
                          f"({prev_obj['x']},{prev_obj['y']}) → ({obj['x']},{obj['y']}) OK")

        # ── CHECK 4: Palette version ─────────────────────────────────
        print("\n" + "-" * 80)
        print("CHECK 4: Palette version progression")
        print("-" * 80)
        show_ds_with_pds = [d for d in ds_list if d['num_objects'] > 0 and d['pds_entries'] > 0]
        pal_versions = [(d['pts_ms'], d['comp_state_name'], d['pds_pal_version'])
                        for d in show_ds_with_pds]
        for pts_ms, csn, ver in pal_versions:
            print(f"  {csn:6s} @{pts_ms:8.1f}ms: palette_version={ver}")
        all_v0 = all(v == 0 for _, _, v in pal_versions)
        if all_v0 and len(pal_versions) > 1:
            issue = "  *** ISSUE: All PDS use palette_version=0. Decoders may skip updates."
            print(issue)
            issues_found.append("Stale palette_version=0")

        # ── CHECK 5: Normal without WDS ──────────────────────────────
        print("\n" + "-" * 80)
        print("CHECK 5: WDS presence per composition state")
        print("-" * 80)
        for d in ds_list:
            if d['num_objects'] > 0:
                print(f"  {d['comp_state_name']:6s} @{d['pts_ms']:8.1f}ms: "
                      f"WDS={'present' if d['has_wds'] else 'ABSENT'}")

        # ── Summary ──────────────────────────────────────────────────
        print("\n" + "=" * 80)
        print(f"SUMMARY: {len(issues_found)} issues found")
        for iss in issues_found:
            print(f"  - {iss}")
        print(f"Writer stats: {writer.stats}")
        print("=" * 80 + "\n")

        # Assertions — fail the test if critical issues found
        pds_issues = [i for i in issues_found if 'PDS partial' in i]
        coord_issues = [i for i in issues_found if 'Coord drift' in i]
        gap_issues = [i for i in issues_found if 'Gap' in i]
        ver_issues = [i for i in issues_found if 'palette_version' in i]

        assert not pds_issues, f"Normal PDS sends partial palette: {pds_issues}"
        assert not coord_issues, f"Unchanged object coordinates drifted: {coord_issues}"
        assert not gap_issues, f"Timing gaps produce blank frames: {gap_issues}"
        assert not ver_issues, f"Palette version never increments: {ver_issues}"

    finally:
        os.unlink(tmp_path)


if __name__ == '__main__':
    test_epoch_diagnostic_trace()
