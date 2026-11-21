"""Controlled fixture parser; NOT used instead of real Pi generation in live acceptance."""
import json
import re
import sys
from datetime import date, datetime
from openpyxl import load_workbook

def clean(value):
    return "" if value is None else str(value).strip()

def field(value):
    s = re.sub(r"[\s'’]", "", clean(value)).upper()
    aliases = {"航线": "route", "ROUTE": "route", "起运港": "origin", "ORIGIN": "origin",
               "目的港": "destination", "DESTINATION": "destination", "20GP": "20GP卖价",
               "40GP": "40GP卖价", "40HQ": "40HQ卖价", "40HC": "40HQ卖价",
               "预计开船日期": "ETD", "开船日期": "ETD", "有效日期": "ETD", "ETD": "ETD",
               "备注": "remark", "REMARKS": "remark", "中转港": "中转港", "航程": "航程", "航线代码": "航线代码"}
    return "lss" if s.startswith("LSS") else aliases.get(s)

wb = load_workbook(sys.argv[1], data_only=True)
result = []
for ws in wb.worksheets:
    active = {}
    pending = {}
    shared = [re.split(r"[:：]", clean(c.value), 1)[1].strip() for row in ws.iter_rows() for c in row if re.match(r"^共享说明[:：]", clean(c.value))]
    for row in ws.iter_rows():
        values = {c.column: c.value for c in row}
        starts = [c.column for c in row if field(c.value) in ("route", "origin")]
        if starts:
            for i, start in enumerate(starts):
                end = starts[i + 1] if i + 1 < len(starts) else ws.max_column + 1
                fields = {field(c.value): c.column for c in row if start <= c.column < end and field(c.value)}
                for c in ws[row[0].row + 1]:
                    if start <= c.column < end and field(c.value) and field(c.value) not in fields:
                        fields[field(c.value)] = c.column
                context = dict(pending)
                if start in active and active[start][1] == fields and not pending:
                    context = dict(active[start][3])
                for title_row in ws.iter_rows(min_row=max(1, row[0].row - 3), max_row=row[0].row - 1):
                    for title in title_row:
                        if start <= title.column < end and clean(title.value) in ("主运价", "附加费"):
                            context["tariffType"] = "surcharge" if clean(title.value) == "附加费" else "main_fare"
                active[start] = (end, fields, "", context)
            pending = {}
            continue
        if any(re.match(r"^(币种|单位|有效期|备注|共享说明|归属不明)[:：]", clean(v)) for v in values.values()):
            for v in values.values():
                s = clean(v)
                if re.match(r"^(币种|单位|有效期|备注|共享说明)[:：]", s):
                    if s.startswith("共享说明"):
                        continue
                    k = "币种" if s.startswith("币种") else "单位" if s.startswith("单位") else "contextRemark"
                    pending[k] = re.split(r"[:：]", s, 1)[1].strip()
            continue
        for start, (end, fields, previous, context) in list(active.items()):
            get = lambda name: values.get(fields.get(name))
            prices = [get(k) for k in ("20GP卖价", "40GP卖价", "40HQ卖价")]
            if all(v is None or v == "" for v in prices) or any(field(v) in ("20GP卖价", "40GP卖价", "40HQ卖价") for v in prices):
                continue
            route = clean(get("route")) or previous
            active[start] = (end, fields, route, context)
            parts = re.split(r"[-=＝]", route, maxsplit=1)
            record_id = f"{ws.title}!R{row[0].row}C{start}"
            record = {"recordId": record_id, "sourceId": record_id,
                      "origin": clean(get("origin")) if "origin" in fields else parts[0].strip(),
                      "destination": clean(get("destination")) if "destination" in fields else parts[1].strip() if len(parts) > 1 else "",
                      "20GP卖价": prices[0], "40GP卖价": prices[1], "40HQ卖价": prices[2],
                      "运价备注": " | ".join(v for v in (clean(get("lss")), clean(get("remark")), context.get("contextRemark", ""), *shared) if v),
                      "中转港": get("中转港"), "航程": get("航程"), "航线代码": get("航线代码"), "ETD": get("ETD")}
            for key in ("币种", "单位"):
                if context.get(key):
                    record[key] = context[key]
            if context.get("tariffType"):
                record["tariffType"] = context["tariffType"]
            result.append(record)
json.dump(result, open(sys.argv[2], "w"), ensure_ascii=False, default=lambda x: x.isoformat() if isinstance(x, (date, datetime)) else str(x))
