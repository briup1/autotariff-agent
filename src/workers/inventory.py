"""Read original OOXML facts before any filtering; never use candidate output."""
import hashlib
import json
import sys
from datetime import date, datetime
from openpyxl import load_workbook
from openpyxl.cell.rich_text import CellRichText
from openpyxl.utils import get_column_letter

path = sys.argv[1]
wb = load_workbook(path, data_only=False, rich_text=True)
cached = load_workbook(path, data_only=True)
cells, sheets, warnings = [], [], []

def scalar(value):
    """Serialize source facts without discarding dates or rich text."""
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return str(value) if isinstance(value, CellRichText) else value

for ws in wb.worksheets:
    merges = list(ws.merged_cells.ranges)
    sheets.append({"name": ws.title, "maxRow": ws.max_row, "maxColumn": ws.max_column,
                   "hidden": ws.sheet_state != "visible", "mergedRanges": [str(r) for r in merges]})
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is None and not cell.has_style:
                continue
            formula = cell.value if cell.data_type == "f" else None
            value = cached[ws.title][cell.coordinate].value if formula else cell.value
            runs = []
            if isinstance(cell.value, CellRichText):
                for run in cell.value:
                    runs.append({"text": str(run) if isinstance(run, str) else run.text,
                                 "strike": False if isinstance(run, str) else bool(run.font.strike)})
            column_hidden = any(d.hidden and (d.min or cell.column) <= cell.column <= (d.max or cell.column)
                                for d in ws.column_dimensions.values())
            merge = next((str(r) for r in merges if cell.coordinate in r), None)
            unsupported = []
            if formula and value is None:
                unsupported.append("FORMULA_CACHE_MISSING")
            if ws.conditional_formatting:
                unsupported.append("CONDITIONAL_STYLE_NOT_EVALUATED")
            cells.append({"sourceId": f"{ws.title}!{cell.coordinate}", "sheet": ws.title,
                          "coordinate": cell.coordinate, "row": cell.row, "column": cell.column,
                          "value": scalar(value), "rawValue": scalar(cell.value), "formula": formula,
                          "displayedValue": "" if cell.number_format == ";;;" else scalar(value),
                          "displayApproximate": cell.number_format not in ("General", "@", ";;;"),
                          "hiddenRow": bool(ws.row_dimensions[cell.row].hidden), "hiddenColumn": bool(column_hidden),
                          "hiddenSheet": ws.sheet_state != "visible", "mergedRange": merge,
                          "style": {"strike": bool(cell.font.strike), "richText": runs,
                                    "numberFormat": cell.number_format, "fontColor": str(cell.font.color.value) if cell.font.color else None,
                                    "fill": str(cell.fill.fgColor.value), "bold": bool(cell.font.bold)},
                          "unsupported": unsupported})
print(json.dumps({"sourceSha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
                  "sheets": sheets, "cells": cells, "warnings": warnings}, ensure_ascii=False, default=str))
