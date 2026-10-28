import ExcelJS from 'exceljs';
import type { Parser } from './types.js';
import { stem } from './shared/text.js';
import { tableSections } from './shared/table.js';

// Excel workbooks: every sheet rendered as `a | b | c` rows (formatted cell
// values, formula results), split into sections that repeat the header row.
export const xlsxParser: Parser = {
  id: 'xlsx',
  label: 'Excel',
  extensions: ['.xlsx', '.xlsm'],
  async parse({ buffer, name }) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sections: string[] = [];
    const sheets: string[] = [];
    let totalRows = 0;
    workbook.eachSheet((sheet) => {
      sheets.push(sheet.name);
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = [];
        for (let c = 1; c <= row.cellCount; c++) cells.push(cellText(row.getCell(c)));
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        rows.push(cells);
      });
      totalRows += rows.length;
      sections.push(...tableSections(`Sheet: ${sheet.name}`, rows));
    });
    const title = workbook.title?.trim() || stem(name);
    return { text: sections.join('\n\n'), title, structure: 'markdown', metadata: { sheets, rows: totalRows } };
  },
};

function cellText(cell: ExcelJS.Cell): string {
  try {
    return (cell.text ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return String(cell.value ?? '').trim();
  }
}
