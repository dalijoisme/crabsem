// utils/exportBuilder.js - generic CSV/XLSX file generation shared by
// every exportable table in the CEO Dashboard (Section 10). Every
// caller supplies real, already-computed { columns, rows } - this
// file only formats it; it never computes or fabricates a value.

const ExcelJS = require("exceljs");

function csvEscape(value){

    if(value == null) return "";

    const s = String(value);

    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

}

function toCsv(columns, rows){

    const header = columns.map(c => csvEscape(c.label)).join(",");

    const lines = rows.map(row => columns.map(c => csvEscape(row[c.key])).join(","));

    return [header, ...lines].join("\r\n");

}

async function toXlsxBuffer(sheetName, columns, rows){

    const workbook = new ExcelJS.Workbook();

    const sheet = workbook.addWorksheet(sheetName.slice(0, 31)); // Excel's real 31-char sheet-name limit

    sheet.columns = columns.map(c => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 2) }));

    rows.forEach(row => sheet.addRow(row));

    sheet.getRow(1).font = { bold: true };

    return workbook.xlsx.writeBuffer();

}

module.exports = { toCsv, toXlsxBuffer };
