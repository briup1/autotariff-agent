"""Local PDF/DOCX/image facts and source-mapped workbook conversion. No model or old project imports."""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from openpyxl import Workbook
from openpyxl.utils import get_column_letter

source, output = sys.argv[1:3]
kind = os.path.splitext(source)[1].lower()
units, tables, warnings = [], [], []
if kind == ".pdf":
    import pymupdf
    document = pymupdf.open(source)
    for index, page in enumerate(document):
        text = page.get_text()
        name = f"Page{index + 1}"
        with redirect_stdout(sys.stderr):
            found = page.find_tables()
        table_rows = []
        for table in found.tables:
            table_rows.extend(table.extract())
        units.append({"id": name, "text": text, "bbox": list(page.rect), "blocks": page.get_text("blocks")})
        tables.append((name, table_rows))
        if not text.strip():
            warnings.append({"code": "IMAGE_ONLY_PDF", "unit": name})
elif kind == ".docx":
    from docx import Document
    doc = Document(source)
    text = "\n".join(p.text for p in doc.paragraphs)
    for index, table in enumerate(doc.tables):
        rows = [[c.text for c in row.cells] for row in table.rows]
        tables.append((f"Table{index + 1}", rows))
    units.append({"id": "Document", "text": text, "paragraphs": len(doc.paragraphs), "tables": len(doc.tables)})
elif kind in (".png", ".jpg", ".jpeg"):
    ocr_bin = sys.argv[3]
    completed = subprocess.run([ocr_bin, source], capture_output=True, text=True, check=True, timeout=60)
    lines = json.loads(completed.stdout)
    units.append({"id": "Image", "text": "\n".join(row["text"] for row in lines), "lines": lines})
    warnings.append({"code": "OCR_REQUIRES_VISUAL_REVIEW", "unit": "Image"})
else:
    raise ValueError("Unsupported input type")

# Narrow narrative grammar is explicit. Other layouts produce a blocking coverage gap.
header = ["Route", "20GP", "40GP", "40HQ", "ETD", "备注"]
for unit in units:
    if any(name == unit["id"] and rows for name, rows in tables):
        continue
    rows = [header]
    pattern = r"Route\s+([A-Z]+[-=][A-Z]+).*?20GP\s+(?:USD\s+)?(-?[\d,.]+).*?40GP\s+(?:USD\s+)?(-?[\d,.]+).*?40HQ\s+(?:USD\s+)?(-?[\d,.]+).*?ETD\s+([\d-]+)"
    for match in re.finditer(pattern, unit["text"], re.I):
        rows.append([match.group(1), *[float(match.group(i).replace(",", "")) for i in (2, 3, 4)], match.group(5), ""])
    if len(rows) > 1:
        tables.append((unit["id"], rows))
    elif unit["text"].strip():
        warnings.append({"code": "UNMAPPED_ORIGINAL_TEXT", "unit": unit["id"], "text": unit["text"]})

wb = Workbook()
wb.remove(wb.active)
cells, sheets, mapping = [], [], []
for name, rows in tables:
    if not rows:
        continue
    ws = wb.create_sheet(name)
    for r, row in enumerate(rows, 1):
        ws.append(row)
        for c, raw in enumerate(row, 1):
            value = raw
            if r > 1 and c in (2, 3, 4) and raw not in (None, ""):
                try:
                    value = float(str(raw).replace(",", ""))
                    ws.cell(r, c, value)
                except ValueError:
                    pass
            coordinate = f"{get_column_letter(c)}{r}"
            cells.append({"sourceId": f"{name}!{coordinate}", "sheet": name, "coordinate": coordinate,
                          "row": r, "column": c, "value": value, "rawValue": raw, "formula": None,
                          "hiddenRow": False, "hiddenColumn": False})
            mapping.append({"converted": f"{name}!{coordinate}", "originalUnit": name, "originalRow": r,
                            "originalColumn": c, "value": raw})
    sheets.append({"name": name, "maxRow": ws.max_row, "maxColumn": ws.max_column, "hidden": False})
if not wb.worksheets:
    wb.create_sheet("Unmapped")
if output != "-":
    wb.save(output)
print(json.dumps({"kind": kind, "units": units, "mapping": mapping, "warnings": warnings,
                  "inventory": {"sourceSha256": hashlib.sha256(open(source,"rb").read()).hexdigest(),
                                "sheets": sheets, "cells": cells,
                                "warnings": [w["code"] for w in warnings]}}, ensure_ascii=False, default=str))
