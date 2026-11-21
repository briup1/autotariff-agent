import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PYTHON } from "../src/closure/paths.js";
import { exportRecords, previewWorkbook } from "../src/closure/spreadsheet.js";

describe("xlsx export and preview", () => {
  it("writes committed records as a real workbook and previews them read-only", async () => {
    const rows = [
      { sourceId: "Rates!R2C1", destination: "宁波", "20GP卖价": 1200, "40GP卖价": null },
      { sourceId: "Rates!R3C1", destination: "深圳", "20GP卖价": -5 },
    ];
    const bytes = await exportRecords(PYTHON, rows);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    const directory = await mkdtemp(resolve(tmpdir(), "xlsx-preview-"));
    try {
      const path = resolve(directory, "result.xlsx");
      await writeFile(path, bytes);
      const preview = await previewWorkbook(PYTHON, path);
      expect(preview.sheets).toHaveLength(1);
      expect(preview.sheets[0]).toMatchObject({ name: "records", truncated: false, totalRows: 3 });
      expect(preview.sheets[0].rows[0]).toEqual(["sourceId", "destination", "20GP卖价", "40GP卖价"]);
      expect(preview.sheets[0].rows[1]).toEqual(["Rates!R2C1", "宁波", 1200]);
      expect(preview.sheets[0].rows[2]).toEqual(["Rates!R3C1", "深圳", -5]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);

  it("refuses to preview a file that is not a workbook", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "xlsx-preview-"));
    try {
      const path = resolve(directory, "broken.xlsx");
      await writeFile(path, "not a workbook");
      await expect(previewWorkbook(PYTHON, path)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
