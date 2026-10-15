/**
 * XLSX writer unit tests (no database): the export must be a valid OOXML package.
 *
 * The file is parsed back with only node:zlib — independent of the writer's own code
 * path — so a broken central directory, CRC or deflate stream fails here instead of in
 * the recipient's Excel.
 */

import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildXlsx } from "@/modules/reports/xlsx";

type Read = { name: string; data: string };

/** Minimal ZIP reader: walk the central directory, inflate each entry. */
function readZip(buf: Buffer): Read[] {
  const EOCD = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(EOCD).toBeGreaterThan(0);
  const count = buf.readUInt16LE(EOCD + 10);
  let offset = buf.readUInt32LE(EOCD + 16);
  const out: Read[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50);
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressed = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localAt = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    expect(buf.readUInt32LE(localAt)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compressed);
    expect(method).toBe(8); // deflate
    const data = inflateRawSync(raw);
    expect(data.length).toBe(size);
    expect(crcOf(data)).toBe(crc); // CRC-32 matches the payload
    out.push({ name, data: data.toString("utf8") });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function crcOf(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

const parts = (buf: Buffer) => new Map(readZip(buf).map((e) => [e.name, e.data]));

describe("xlsx writer", () => {
  const rows: (string | number | null)[][] = [
    ["standard", 15, 130, 19.5, 1],
    ["عميل عابر", 0, 0, '"«خصم»" & <سطر>', null],
  ];
  const buf = buildXlsx({
    sheetName: "R-60 sheet/name:with*invalid?chars",
    header: ["تصنيف الضريبة", "النسبة", "الصافي", "الضريبة", "البنود"],
    rows,
    totals: ["الإجمالي", null, 130, 19.5, 1],
  });
  const zip = parts(buf);

  it("is a ZIP with the five parts a viewer needs", () => {
    expect([...zip.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(zip.get("[Content_Types].xml")).toContain("spreadsheetml.sheet.main+xml");
  });

  it("declares the worksheet relationship the workbook points to", () => {
    expect(zip.get("xl/workbook.xml")).toContain('r:id="rId1"');
    expect(zip.get("xl/_rels/workbook.xml.rels")).toContain("worksheets/sheet1.xml");
  });

  it("keeps the sheet name inside Excel's limits", () => {
    const name = /name="([^"]+)"/.exec(zip.get("xl/workbook.xml") ?? "")?.[1] ?? "";
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });

  it("writes Arabic text as inline strings and money as numbers", () => {
    const sheet = zip.get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain("تصنيف الضريبة");
    expect(sheet).toContain("عميل عابر");
    expect(sheet).toContain('<c r="C2"><v>130</v></c>'); // numeric, not text
    expect(sheet).toContain('<c r="E2"><v>1</v></c>');
  });

  it("escapes XML metacharacters and drops empty cells", () => {
    const sheet = zip.get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain("&quot;«خصم»&quot; &amp; &lt;سطر&gt;");
    expect(sheet).not.toContain("<سطر>");
    // the null in the totals row must not produce a cell
    expect(sheet).not.toMatch(/<c r="B4"/);
  });

  it("sets an RTL sheet view, freezes the header and marks the used range", () => {
    const sheet = zip.get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('ySplit="1"');
    expect(sheet).toContain('dimension ref="A1:E4"');
  });
});
