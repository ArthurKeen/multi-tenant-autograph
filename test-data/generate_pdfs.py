#!/usr/bin/env python3
"""Generate a PDF next to every .txt file under test-data/.

Used to exercise the PDF ingest path of the GraphRAG prototype with the same
fictional content as the .txt sources. Generated PDFs are gitignored.

Requires reportlab:  pip install reportlab
"""

from __future__ import annotations

from pathlib import Path

try:
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas
except ImportError:
    raise SystemExit(
        "reportlab is required. Install it with:  pip install reportlab"
    )

TEST_DATA_DIR = Path(__file__).resolve().parent
LEFT_MARGIN = 1 * inch
TOP_MARGIN = 1 * inch
LINE_HEIGHT = 14
FONT_NAME = "Helvetica"
FONT_SIZE = 10
MAX_CHARS_PER_LINE = 95


def wrap_line(line: str) -> list[str]:
    """Soft-wrap a single logical line to fit the page width."""
    if not line:
        return [""]
    words = line.split(" ")
    wrapped: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if len(candidate) <= MAX_CHARS_PER_LINE:
            current = candidate
        else:
            if current:
                wrapped.append(current)
            current = word
    wrapped.append(current)
    return wrapped


def txt_to_pdf(txt_path: Path, pdf_path: Path) -> None:
    page_width, page_height = LETTER
    pdf = canvas.Canvas(str(pdf_path), pagesize=LETTER)
    pdf.setFont(FONT_NAME, FONT_SIZE)
    y = page_height - TOP_MARGIN

    for raw_line in txt_path.read_text(encoding="utf-8").splitlines():
        for line in wrap_line(raw_line):
            if y < TOP_MARGIN:
                pdf.showPage()
                pdf.setFont(FONT_NAME, FONT_SIZE)
                y = page_height - TOP_MARGIN
            pdf.drawString(LEFT_MARGIN, y, line)
            y -= LINE_HEIGHT

    pdf.save()


def main() -> None:
    txt_files = sorted(TEST_DATA_DIR.glob("tenant-*/*.txt"))
    if not txt_files:
        raise SystemExit(f"No .txt files found under {TEST_DATA_DIR}")
    for txt_path in txt_files:
        pdf_path = txt_path.with_suffix(".pdf")
        txt_to_pdf(txt_path, pdf_path)
        print(f"wrote {pdf_path.relative_to(TEST_DATA_DIR)}")


if __name__ == "__main__":
    main()
