# Jellyfin Web: acquisition foundation

Scope approved in Discord on 2026-10-18 UTC (2026-10-17 Eastern).
This is an implementation checkpoint, **not working Jellyfin support yet**.
These modules are deliberately not registered as content scripts or a platform;
the running extension, permissions, existing adapters and backend are unchanged.

## Included

- Explicit server API base URL normalization, preserving ports and reverse-proxy
  paths while refusing credentials, query parameters and unsafe path components.
- Stable identity across server, base path, item GUID and media-source ID; a
  separate required playback epoch protects A-to-B-to-A navigation and logout/
  session replacement even when stable identity matches again.
- Sanitized PlaybackInfo parsing for an explicitly selected media source, not
  `MediaSources[0]`. Only an allowlist of fields leaves the parser. Stream URLs,
  filesystem paths, session fields and HTTP headers are not propagated.
- Language normalization including Jellyfin's ISO-639-2 tags; independent SDH,
  forced and external flags; explicit image/unknown subtitle counts and detection
  of selected burned-in subtitles.
- Credential-free construction of a whole-file VTT route for a known text stream.
- A read-only injected transport boundary with required cancellation, one overall
  20-second deadline, no retries, active/epoch checks before dispatch and before
  publishing, bounded parsing and non-sensitive errors.
- A pure clock mapping for original-media cues: video time + actual transcode
  offset + subtitle offset. Positive subtitle offset displays raw cues earlier,
  hence it is added to the lookup clock. HLS may already be absolute; a guessed
  resume position must never be substituted for the actual transcode offset.

All fixtures are synthetic, based on upstream DTO/controller/player source.
They do **not** establish behavior against a particular released server version.
The text-codec classifier is not a promise that every deployed server can
convert ASS/SSA/other text formats to VTT; conversion failure remains separate.

## Security / integration contract

The caller must keep the authoritative snapshot and epoch in MAIN world and
increment the epoch on playback/session replacement. Do not deserialize a page
message into a trusted snapshot. The future bridge should take a known track ID
and perform a validated read, not expose an arbitrary authenticated URL proxy.

The transport must use the existing authenticated Jellyfin page context without
copying session credentials into Loom storage, logs, message payloads or API
requests. It must bound response size while reading too; the current helper's
8-Mi-character check bounds parsing, not the transport's earlier allocation.

Server enrollment should request optional host permission only following an
explicit user action. Browser match-pattern grants may be coarser than a server's
port/base path, so the implementation must still enforce the exact configured
origin and base path. MV3 Chrome and MV2 Firefox need separate validation.

Do not capture Jellyfin subtitles into the corpus as an accidental side effect
of reusing discover.ts. Explain that enabled annotation/romanization sends text
to the Loom API; this integration is not an entirely local processing feature.

## Remaining before this is usable

1. Confirm the actual deployed Jellyfin server and Web client versions.
2. Establish and test a reload-safe MAIN bridge to the active authenticated
   player, including current item/source/epoch and real clock offsets. Do not
   assume webpack-imported playbackManager or ApiClient is a window global.
3. Add explicit server enrollment, optional permission/injection, revocation,
   and the kill-switch behavior for both browser manifests.
4. Register the Jellyfin platform and player seam; mount the shared overlay,
   suppress native text captions only after successful takeover, restore on
   teardown, and refuse to imply burned-in captions can be erased.
5. Test actual VTT reads for embedded/external text, direct play and resume/
   transcode, subtitle delays, next episode, alternate media sources, logout,
   reverse-proxy paths and permission revocation.

Image-only OCR, native/TV/mobile clients and remote/cast playback are out of scope.

## Verification

```sh
npm --workspace apps/extension exec -- wxt prepare
npm --workspace apps/extension test -- lib/captions/jellyfin --maxWorkers=1
npm --workspace apps/extension run compile
```

Also run the complete existing extension/player-ui suite and both production
builds. Since these modules are not wired into an entrypoint, successful browser
builds establish no existing-build regression, **not** live Jellyfin compatibility.

## Source basis

Jellyfin server snapshot `08c2ba6e0b6499122822f1c5b18bc426104538b4`:
`MediaBrowser.Model/Entities/MediaStream.cs`, `MediaBrowser.Model/Dto/MediaSourceInfo.cs`,
`Jellyfin.Api/Controllers/SubtitleController.cs`, and
`MediaBrowser.MediaEncoding/Subtitles/SubtitleEncoder.cs`.

Jellyfin Web snapshot `ee8efb417e5377ba444509a68ed22af33e45950b`:
`src/components/playback/playbackmanager.js` and
`src/plugins/htmlVideoPlayer/plugin.js`.

These are upstream source snapshots examined during research, not assertions
that the user's deployed version matches master.