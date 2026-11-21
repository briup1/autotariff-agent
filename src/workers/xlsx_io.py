"""Local XLSX write and read-only preview. argv only, no network, no host paths."""

import datetime
import json
import sys

MAX_SHEETS = 6
MAX_ROWS = 200
MAX_COLUMNS = 40
MAX_CELL = 400


def plain(value):
    if value is None:
        return None
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, str)):
        return value if not isinstance(value, str) or len(value) <= MAX_CELL else value[:MAX_CELL] + "…"
    return str(value)[:MAX_CELL]


def export(source, target):
    import openpyxl

    with open(source, encoding="utf-8") as handle:
        rows = json.load(handle)
    if not isinstance(rows, list):
        raise SystemExit("export expects a JSON array")
    columns = []
    for row in rows:
        if not isinstance(row, dict):
            raise SystemExit("export expects JSON objects")
        for key in row:
            if key not in columns:
                columns.append(key)
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "records"
    if columns:
        sheet.append(columns)
        for row in rows:
            sheet.append([plain(row.get(key)) for key in columns])
        sheet.freeze_panes = "A2"
    book.save(target)


def preview(source):
    import openpyxl

    book = openpyxl.load_workbook(source, read_only=True, data_only=True)
    sheets = []
    try:
        count = len(book.sheetnames)
        for name in book.sheetnames[:MAX_SHEETS]:
            sheet = book[name]
            rows, truncated = [], False
            for row in sheet.iter_rows(max_col=MAX_COLUMNS):
                if len(rows) >= MAX_ROWS:
                    truncated = True
                    break
                values = [plain(cell.value) for cell in row]
                while values and values[-1] in (None, ""):
                    values.pop()
                rows.append(values)
            while rows and all(value in (None, "") for value in rows[-1]):
                rows.pop()
            while rows and not rows[0]:
                rows.pop(0)
            sheets.append(
                {
                    "name": name,
                    "rows": rows,
                    "truncated": truncated,
                    "totalRows": min(sheet.max_row or 0, 100000),
                    "totalColumns": min(sheet.max_column or 0, 100000),
                }
            )
    finally:
        book.close()
    print(json.dumps({"sheets": sheets, "sheetCount": count}))


def main(argv):
    if len(argv) >= 4 and argv[1] == "export":
        export(argv[2], argv[3])
        return 0
    if len(argv) >= 3 and argv[1] == "preview":
        preview(argv[2])
        return 0
    raise SystemExit("usage: xlsx_io.py export <json> <xlsx> | preview <xlsx>")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
