#!/usr/bin/env python3
"""Import original F1 artwork without changing or recompressing the archive.

    python3 scripts/import-archive.py --archive ~/Archive.zip

Python's standard library is sufficient when reusing the checked-in artwork.json
and f1-logo.svg. To rebuild layout measurements and the logo from the Illustrator
files, install PyMuPDF (`python3 -m pip install PyMuPDF`) and pass --inspect-ai.
PyMuPDF is also used automatically when the checked-in metadata does not exist.
FontTools is not needed. Font binaries are deliberately not imported.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import struct
from typing import Any
import zipfile


# Source folder, basename, circuit identity, exact displayed venue alias.
# Circuit identities deliberately remain independent of calendar event names.
SOURCES = {
    "2025": [
        ("01 Australian", "Australian", "melbourne", "AUSTRALIA"),
        ("02 Chinese", "Chinese", "shanghai", "CHINA"),
        ("03 Japanese", "Japanese", "suzuka", "JAPAN"),
        ("04 Bahrain", "Bahrain", "sakhir", "BAHRAIN"),
        ("05 Saudi Arabian", "Saudi Arabian", "jeddah", "SAUDI ARABIA"),
        ("06 Miami", "Miami", "miami", "MIAMI"),
        ("07 Emilia Romagna", "Emilia Romagna", "imola", "Emilia Romagna"),
        ("08 Monaco", "Monaco", "monaco", "MONACO"),
        ("09 Spanish", "Spanish", "barcelona", "SPAIN"),
        ("10 Canadian", "Canadian", "montreal", "CANADA"),
        ("11 Austrian", "Austrian", "spielberg", "AUSTRIA"),
        ("12 British", "British", "silverstone", "BRITAIN"),
        ("13 Belgian", "Belgian", "spa", "BELGIUM"),
        ("14 Hungarian", "Hungary", "hungaroring", "HUNGARY"),
        ("15 Dutch", "Dutch", "zandvoort", "DUTCH"),
        ("16 Italian", "Italian", "monza", "ITALY"),
        ("17 Azerbaijan", "Azerbaijan", "baku", "AZERBAIJAN"),
        ("18 Singapore", "Singapore", "marina-bay", "SINGAPORE"),
        ("19 United States", "United States", "austin", "UNITED STATES"),
        ("20 Mexico City", "Mexico City", "mexico-city", "MEXICO"),
        ("21 Sao Paulo", "Sao Paulo", "interlagos", "SAO PAULO"),
        ("22 Las Vegas", "Las Vegas", "las-vegas", "LAS VEGAS"),
        ("23 Qatar", "Qatar", "lusail", "QATAR"),
        ("24 Abu Dhabi", "Abu Dhabi", "yas-marina", "ABU DHABI"),
    ],
    "2026": [
        ("01 Australian", "Australian", "melbourne", "AUSTRALIA"),
        ("02 Chinese", "Chinese", "shanghai", "CHINA"),
        ("03 Japanese", "Japanese", "suzuka", "JAPAN"),
        ("04 Bahrain", "Bahrain", "sakhir", "BAHRAIN"),
        ("05 Saudi Arabian", "Saudi Arabian", "jeddah", "SAUDI ARABIA"),
        ("06 Miami", "Miami", "miami", "MIAMI"),
        ("07 Canadian", "Canadian", "montreal", "CANADA"),
        ("08 Monaco", "Monaco", "monaco", "MONACO"),
        ("09 Barcelona-Catalunya", "Barcelona-Catalunya", "barcelona", "BARCELONA-CATALUNYA"),
        ("10 Austrian", "Austrian", "spielberg", "AUSTRIA"),
        ("11 British", "British", "silverstone", "BRITAIN"),
        ("12 Belgian", "Belgian", "spa", "BELGIUM"),
        ("13 Hungarian", "Hungary", "hungaroring", "HUNGARY"),
        ("14 Dutch", "Dutch", "zandvoort", "DUTCH"),
        ("15 Italian", "Italian", "monza", "ITALY"),
        ("16 Spanish", "Spanish", "madrid", "SPAIN"),
        ("17 Azerbaijan", "Azerbaijan", "baku", "AZERBAIJAN"),
        ("18 Singapore", "Singapore", "marina-bay", "SINGAPORE"),
        ("19 United States", "United States", "austin", "UNITED STATES"),
        ("20 Mexico", "Mexico", "mexico-city", "MEXICO"),
        ("21 Brazil", "Brazil", "interlagos", "BRAZIL"),
        ("22 Las Vegas", "Las Vegas", "las-vegas", "LAS VEGAS"),
        ("23 Qatar", "Qatar", "lusail", "QATAR"),
        ("24 Abu Dhabi", "Abu Dhabi", "yas-marina", "ABU DHABI"),
    ],
}

FONT_SOURCES = {
    "wide": {
        "family": "Formula1-Display-Wide",
        "sourceUrl": "https://www.formula1.com/s/fonts/formula1/Formula1-Wide.woff2",
        "fileName": "Formula1-Wide.woff2",
    },
    "bold": {
        "family": "Formula1-Display-Bold",
        "sourceUrl": "https://www.formula1.com/s/fonts/formula1/Formula1-Bold.woff2",
        "fileName": "Formula1-Bold.woff2",
    },
}


def background_key(year: str, venue: str) -> str:
    if venue == "barcelona":
        return f"barcelona-{year}"
    if venue == "madrid":
        return "barcelona-2025"  # Provenance only; never a usable Madrid asset.
    return venue


def png_dimensions(data: bytes) -> tuple[int, int]:
    if data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
        raise ValueError("Expected an original PNG background")
    return struct.unpack(">II", data[16:24])


def rounded(value: float) -> float:
    return round(float(value), 6)


def text_style(spans: list[dict[str, Any]], alignment: str) -> dict[str, Any]:
    if not spans:
        raise ValueError("Expected an editable overlay text field")
    first = spans[0]
    result = {
        "fontFamily": first["font"].split("+")[-1],
        "fontSize": rounded(first["size"]),
        "fill": f"#{first['color']:06x}",
        "baselineY": rounded(first["origin"][1]),
        "sourceText": "".join(span["text"] for span in spans),
    }
    left = min(span["bbox"][0] for span in spans)
    right = max(span["bbox"][2] for span in spans)
    result["centerX" if alignment == "center" else "rightX"] = rounded(
        (left + right) / 2 if alignment == "center" else right
    )
    return result


def inspect_page(page: Any, fitz: Any) -> dict[str, Any]:
    flags = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES
    spans = [
        span
        for block in page.get_text("dict", flags=flags)["blocks"]
        if block["type"] == 0
        for line in block["lines"]
        for span in line["spans"]
    ]
    titles = [span for span in spans if "Display-Wide" in span["font"]]
    rounds = [span for span in spans if span["text"].startswith(("2025", "2026"))]
    sessions = [
        span for span in spans
        if "Display-Bold" in span["font"] and span not in rounds
    ]
    image = page.get_image_info()[0]
    x0, y0, x1, y1 = image["bbox"]
    return {
        "title": text_style(titles, "center"),
        "session": text_style(sessions, "center"),
        "round": text_style(rounds, "right"),
        "backgroundPlacement": {
            "x": rounded(x0), "y": rounded(y0),
            "width": rounded(x1 - x0), "height": rounded(y1 - y0),
        },
    }


def logo_svg(drawing: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    rect = drawing["rect"]

    def point(value: Any) -> str:
        return f"{value.x - rect.x0:.6f} {value.y - rect.y0:.6f}"

    commands: list[str] = []
    previous = None
    for item in drawing["items"]:
        operation, *points = item
        if operation not in ("l", "c"):
            raise ValueError(f"Unexpected logo path operation: {operation}")
        if points[0] != previous:
            if previous is not None:
                commands.append("Z")
            commands.append(f"M {point(points[0])}")
        commands.append(
            f"L {point(points[1])}" if operation == "l"
            else "C " + " ".join(point(value) for value in points[1:])
        )
        previous = points[-1]
    commands.append("Z")
    color = "#" + "".join(f"{round(component * 255):02x}" for component in drawing["fill"])
    width, height = round(rect.width, 3), round(rect.height, 3)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}">\n'
        f'  <path fill="{color}" fill-rule="evenodd" d="{" ".join(commands)}"/>\n'
        '</svg>\n'
    )
    metadata = {
        "file": "assets/f1-logo.svg", "x": rounded(rect.x0),
        "y": rounded(rect.y0), "width": width, "height": height,
        "fill": color,
    }
    return svg, metadata


def inspect_archive(archive: zipfile.ZipFile) -> tuple[dict[str, Any], str]:
    try:
        import fitz
    except ImportError as error:
        raise RuntimeError(
            "Rebuilding AI metadata requires PyMuPDF: python3 -m pip install PyMuPDF. "
            "Reusing the checked-in metadata does not require it."
        ) from error

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "canvas": {"width": 1920, "height": 1080},
        "fonts": FONT_SOURCES,
        "backgrounds": {}, "seasons": {}, "aliases": {},
        "sourceArchive": "Archive.zip",
        "sourceCalendarWarning": "Source rounds and sprint artboards are historical artwork metadata, not live calendar data.",
    }
    svg = ""
    for year, sources in SOURCES.items():
        manifest["seasons"][year] = {}
        manifest["aliases"][year] = {}
        for folder, basename, venue, display_name in sources:
            source_folder = f"{year}/{folder}"
            ai_path = f"{source_folder}/{basename}.ai"
            with fitz.open(stream=archive.read(ai_path), filetype="pdf") as document:
                if any(page.rect.width != 1920 or page.rect.height != 1080 for page in document):
                    raise ValueError(f"Unexpected artboard size in {ai_path}")
                # Race is the final artboard in both two- and four-board sources.
                entry = inspect_page(document[-1], fitz)
                asset_key = background_key(year, venue)
                entry["title"]["text"] = display_name
                entry.update({
                    "venueKey": venue, "displayName": display_name,
                    "backgroundKey": None if venue == "madrid" else asset_key,
                    "missingBackground": venue == "madrid",
                    "sourceRound": int(folder.split(" ", 1)[0]),
                    "sourceFolder": source_folder,
                    "sourceAi": ai_path,
                    "sourceArtboardCount": len(document),
                })
                keys = ["qualifying", "race"] if len(document) == 2 else [
                    "sprint-qualifying", "sprint", "qualifying", "race",
                ]
                entry["sourceSessions"] = keys
                entry["sourceSessionLayouts"] = {
                    key: inspect_page(page, fitz)
                    for key, page in zip(keys, document)
                }
                if venue == "madrid":
                    entry["sourceBackgroundReference"] = asset_key
                    entry["missingReason"] = (
                        "The Spanish 2026 source reuses Barcelona artwork; no Madrid scene is supplied."
                    )
                manifest["seasons"][year][venue] = entry
                for alias in (basename, folder.split(" ", 1)[1], display_name):
                    manifest["aliases"][year][alias.lower().replace(" ", "-")] = venue

                # Prefer full-resolution 2026 sources for shared circuits. Madrid
                # cannot replace the earlier Barcelona asset or become its alias.
                if venue != "madrid":
                    manifest["backgrounds"][asset_key] = {
                        "file": f"assets/backgrounds/{asset_key}.png",
                        "venueKey": venue,
                        "sourceArchivePath": f"{source_folder}/{basename}.png",
                        "sourceAi": ai_path,
                        "sourceKind": "archive-original-png",
                        "placement": entry["backgroundPlacement"],
                    }
                if not svg:
                    svg, manifest["logo"] = logo_svg(document[0].get_drawings()[0])

    # The current Bahrain event may move to Sepang. Sakhir imagery must never be
    # silently borrowed for a different circuit. The parent owns event routing.
    sepang = copy.deepcopy(manifest["seasons"]["2026"]["sakhir"])
    sepang.update({
        "venueKey": "sepang", "backgroundKey": None, "missingBackground": True,
        "sourceFolder": None, "sourceAi": None, "sourceRound": None,
        "sourceArtboardCount": 0, "sourceSessions": [], "sourceSessionLayouts": {},
        "sourceBackgroundReference": None,
        "missingReason": "No Sepang artwork is supplied in the archive.",
        "styleReference": "2026/sakhir",
    })
    manifest["seasons"]["2026"]["sepang"] = sepang
    return manifest, svg


def import_archive(archive_path: Path, project_root: Path, inspect_ai: bool) -> dict[str, Any]:
    manifest_path = project_root / "assets/artwork.json"
    logo_path = project_root / "assets/f1-logo.svg"
    with zipfile.ZipFile(archive_path) as archive:
        if inspect_ai or not manifest_path.exists() or not logo_path.exists():
            manifest, svg = inspect_archive(archive)
        else:
            manifest = json.loads(manifest_path.read_text())
            if manifest.get("schemaVersion") != 1:
                raise ValueError("Unsupported artwork manifest schema")
            svg = logo_path.read_text()
        payloads = []
        for key, background in manifest["backgrounds"].items():
            data = archive.read(background["sourceArchivePath"])
            width, height = png_dimensions(data)
            background.update({
                "width": width, "height": height,
                "sha256": hashlib.sha256(data).hexdigest(),
            })
            destination = project_root / background["file"]
            if not destination.resolve().is_relative_to((project_root / "assets/backgrounds").resolve()):
                raise ValueError(f"Unsafe background destination: {key}")
            payloads.append((destination, data))
        if len(payloads) != 25:
            raise ValueError(f"Expected 25 distinct backgrounds; found {len(payloads)}")
        # Read and validate every source before mutating generated output.
        for destination, data in payloads:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        logo_path.write_text(svg)
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--archive", type=Path, default=Path.home() / "Archive.zip")
    parser.add_argument("--output-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--inspect-ai", action="store_true", help="Rebuild layout/logo from the AI files (requires PyMuPDF)")
    args = parser.parse_args()
    try:
        manifest = import_archive(args.archive.expanduser(), args.output_root.resolve(), args.inspect_ai)
    except (OSError, ValueError, RuntimeError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Artwork import failed: {error}\n")
    total = sum(background["width"] * background["height"] for background in manifest["backgrounds"].values())
    print(f"Imported {len(manifest['backgrounds'])} original backgrounds ({total:,} source pixels), 48 source layouts, and the vector F1 logo.")


if __name__ == "__main__":
    main()
