# Original artwork audit

The source is `~/Archive.zip`, containing the user's original 2025 and 2026 artwork. The archive is never modified by the importer. macOS resource forks and Finder metadata are excluded from this inventory.

## Inventory

263 content files: 48 Illustrator files, 48 Photoshop files, 166 PNGs and one JPG. Each source season has 24 weekend folders.

| Season | Illustrator artboards | Base PNGs | Exported session PNGs |
| --- | ---: | ---: | ---: |
| 2025 | 60 | 24 | 60 |
| 2026 | 66 | 24 | 58 |

All 48 Illustrator files contain PDF-compatible artwork. All 126 artboards measure 1920 × 1080, with a 16:9 aspect ratio. The 2025 session exports measure 8000 × 4500, although their illustrations originate from approximately 1920 × 1080 raster sources. The 2026 exports measure 1920 × 1081 (48), 1921 × 1081 (six), or 1920 × 1080 (four).

## Composition

Every artboard combines one raster illustration, three principal editable text fields, and a vector F1 logo. The car, circuit, landmarks, sky, lighting and texture are raster artwork. The files are hybrid raster/vector assets; a vector wrapper preserves the sharpness of overlays while the illustration retains its native detail.

| Component | Placement | Typography |
| --- | --- | --- |
| Illustration | Full canvas; shared across a weekend's sessions | Original raster scene |
| F1 logo | Upper left: x97.675, y59.286; 200.813 × 49.491 | Red vector compound path |
| Venue | Centered near the top; size and baseline vary by venue | Formula1 Display Wide; venue-specific color |
| Session | Centered; baseline approximately y283.206 | Formula1 Display Bold, size 72 |
| Year and round | Lower right; baseline y1024; right edge approximately x1870 | Formula1 Display Bold, size 60 |

All source captions include the year: `2025 Round 1`, `2026 Round 18`, and so on. A normal weekend supplies `RACE QUALIFYING` and `RACE`; a sprint source additionally supplies `SPRINT QUALIFYING` and `SPRINT RACE`. Venue title sizes range from 50 to 150 in 2026. Colors are chosen for each illustration, rather than being universal theme colors.

The public Illustrator layer names are generic `Layer 1`. Text remains editable in the PDF representation; it has not been converted to vector outlines. Original XMP records refer to linked PNGs in the user's iCloud folder. Some 2025 PDF representations contain only 256 × 144 or 512 × 288 image proxies; all 2026 embedded scenes use the full source dimensions.

Singapore 2026 race measurements illustrate the overlay structure:

| Text | Font | Size | Color | Baseline origin |
| --- | --- | ---: | --- | --- |
| SINGAPORE | Formula1 Display Wide |82| `#973a5f` |431.226,159.894|
| RACE | Formula1 Display Bold |72| `#e99c57` |847.789,283.206|
| 2026 Round 18 | Formula1 Display Bold |60| `#faedde` |1355.984,1024|

## Reuse and exceptions

23 of 24 2026 base PNGs and PSDs match 2025 by ZIP CRC and file size. The 2026 Barcelona-Catalunya illustration is new; Emilia Romagna disappears from that source season. This yields25 unique original backgrounds.

The 2026 Spanish folder still reuses 2025's Barcelona/Sagrada Família illustration. It is recorded as a Madrid event style with a **missing background**, while preserving its Barcelona source reference. No distinct Madrid illustration is supplied. Likewise, the Bahrain source illustrates Sakhir; it cannot stand in for a weekend at Sepang, whose illustration is missing.

Country aliases differ from folder names: Australian becomes `AUSTRALIA`, Japanese becomes `JAPAN`, Canadian becomes `CANADA`, British becomes `BRITAIN`, Dutch remains `DUTCH`, and Spanish becomes `SPAIN`. `SAO PAULO` in 2025 becomes `BRAZIL` in 2026. Emilia Romagna uses mixed case in 2025.

Hungary's native illustration is 1920 ×1084. Its artboard shows the image at y−2, cropping two pixels from each vertical edge. The importer preserves the 1084-pixel original and records that placement.

The Barcelona-Catalunya race artboard contains an extra small Myriad Pro `Barcelona-Catalunya` text object in the illustration. It is not part of the three-field overlay template and is excluded from the imported overlay metadata. Its large venue heading uses 50-pixel Wide text.

Photoshop files mainly contain raster backgrounds and edits with names such as `Extend the track, grandstand...`, `remove building` and `Remove tool edits`. They prepare the scene rather than define session overlays. Singapore, for example, contains a central 1536 ×1024 source extended to 1920 ×1080.

## Historical sprint coverage

These counts describe the supplied files, not the current calendar.

- 2025 sprint artboards and exports: China, Miami, Belgium, United States, São Paulo and Qatar.
- 2026 sprint artboards: China, Miami, Canada, Britain, Belgium, Netherlands, United States, Brazil and Qatar.
- 2026 exported sprint PNGs: China, Miami, Canada, Britain and Netherlands. Belgium, United States, Brazil and Qatar have sprint artboards without corresponding sprint exports.
- Singapore 2026 has only qualifying/race artboards, still labeled Round 18. Bahrain remains Round4 in the supplied files.

## Imported files and schema

`assets/artwork.json` records canvas geometry, the vector logo placement, official font-source URLs, background provenance/checksums, and measured styles keyed by season and circuit identity. Circuit keys remain independent of event names. The calendar can therefore route a Bahrain event to `sepang` without borrowing `sakhir` artwork.

- `backgrounds[key]`: original PNG path, native dimensions, SHA-256, source archive path and canvas placement.
- `seasons[year][venueKey]`: title alias/style, session style, round style, original source folder/round, and `backgroundKey`.
- `missingBackground: true` with `backgroundKey: null`: artwork is absent; the application must use its missing-artwork state.
- `sourceBackgroundReference`: provenance for an unsuitable source illustration; it does not authorize a fallback background.
- `sourceSessions` and `sourceSessionLayouts`: original artboard coverage and exact per-session geometry, including small manual subpixel differences.
- `aliases[year]`: source folder/title aliases to circuit keys; these are archival aliases, not current event routing rules.

The 25 PNGs under `assets/backgrounds/` are copied byte for byte. All 24 2026 base PNGs decode pixel-identically to the full-resolution scenes embedded in their Illustrator files, so extracting those original PNG bytes preserves the intended illustration without recompression. The shared circuits use2026 sources; Imola and the older Barcelona illustration use2025 sources. The two Barcelona artwork versions have separate keys, `barcelona-2025` and `barcelona-2026`.

Reimport using only Python's standard library and the checked-in manifest/logo:

```sh
python3 scripts/import-archive.py --archive ~/Archive.zip
```

To rebuild layout measurements and the normalized vector logo directly from Illustrator, install the optional `PyMuPDF` package and add `--inspect-ai`. FontTools is not required. The importer validates all source PNGs before writing output and never imports the archive's large Photoshop/session exports.
