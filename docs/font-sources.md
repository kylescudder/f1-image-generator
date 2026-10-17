# Matching typography

The original Illustrator files use `Formula1-Display-Wide` for venue headings and `Formula1-Display-Bold` for session and year/round captions. The archive contains embedded subsets, but no standalone TTF, OTF or WOFF files. No complete Formula1 font was found in the checked local font directories or a bounded Spotlight filename search.

The [official Formula1 homepage](https://www.formula1.com/) links [its font stylesheet](https://www.formula1.com/s/fonts.css), which supplies these complete web fonts:

| Face | Official source | PostScript identity |
| --- | --- | --- |
| Wide | [Formula1-Wide.woff2](https://www.formula1.com/s/fonts/formula1/Formula1-Wide.woff2) | `Formula1-Display-Wide` |
| Bold | [Formula1-Bold.woff2](https://www.formula1.com/s/fonts/formula1/Formula1-Bold.woff2) | `Formula1-Display-Bold` |

Both URLs returned HTTP200 and valid WOFF2 files during the audit. Wide is 26,976 bytes with 605glyphs; Bold is 25,388 bytes with 580glyphs. Both identify version 1.001 and contain 352 Unicode mappings. The CSS has no Unicode-range restriction. Its CSS family aliases are `Formula1Wide` and `Formula1`, both with weight 500 for these faces; renderer code should use the actual matched face rather than assume a generic browser bold substitution.

Singapore's embedded Wide subset matches the official face's used outlines and metrics exactly. Its Bold subset matches all measured advances and 20 of 21 used glyph outlines. The uppercase `R` differs at three points, by at most 13 of 1000 font units: less than one pixel at 60-pixel text. Current official typography therefore matches the family and layout without being completely pixel-identical to that original `R`.

Font binaries belong in the runtime's gitignored `data/fonts/`, fetched from the URLs above during setup. Complete proprietary font binaries are not checked into `assets/`. `assets/artwork.json` includes each family, source URL and suggested runtime filename.

Public retrieval establishes technical availability, not an unrestricted redistribution grant. The font metadata reserves copyright, contains no explicit open-license entry, and reports OS/2 embedding flag 4. Formula1's [published guidelines](https://www.formula1.com/en/information/guidelines.4EOKE9RRqevL4niTK9kWyt) identify its official typeface among its intellectual-property assets. These observations document the source; they are not a legal determination.
