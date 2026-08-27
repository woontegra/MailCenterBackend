import * as XLSX from 'xlsx';

export type ParsedContactListFile = {
  headers: string[];
  rows: Record<string, string>[];
  file_kind: 'xlsx' | 'xls' | 'csv';
};

function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function isOleBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0
  );
}

function detectDelimiter(line: string): ',' | ';' | '\t' {
  const candidates: Array<',' | ';' | '\t'> = [',', ';', '\t'];
  let best: ',' | ';' | '\t' = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = line.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function parseCsvBuffer(buffer: Buffer): Record<string, string>[] {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delimiter = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      row.push(current.trim());
      current = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(current.trim());
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      current = '';
    } else {
      current += ch;
    }
  }
  row.push(current.trim());
  if (row.some((v) => v !== '')) rows.push(row);

  const [headers, ...data] = rows;
  if (!headers?.length) return [];
  return data.map((values) => {
    const out: Record<string, string> = {};
    headers.forEach((h, idx) => {
      out[h || `Kolon ${idx + 1}`] = values[idx] || '';
    });
    return out;
  });
}

function parseWorkbookBuffer(buffer: Buffer): Record<string, string>[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[sheetName], { defval: '' });
}

export function parseContactListFile(file: {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
}): ParsedContactListFile {
  const lower = file.originalname.toLowerCase();
  const ext = lower.endsWith('.xlsx')
    ? 'xlsx'
    : lower.endsWith('.xls')
      ? 'xls'
      : lower.endsWith('.csv')
        ? 'csv'
        : null;

  if (isZipBuffer(file.buffer)) {
    const rows = parseWorkbookBuffer(file.buffer);
    return { headers: rows[0] ? Object.keys(rows[0]) : [], rows: rows.slice(0, 5000), file_kind: 'xlsx' };
  }
  if (isOleBuffer(file.buffer)) {
    const rows = parseWorkbookBuffer(file.buffer);
    return { headers: rows[0] ? Object.keys(rows[0]) : [], rows: rows.slice(0, 5000), file_kind: 'xls' };
  }

  if (ext === 'xlsx' || ext === 'xls') {
    throw Object.assign(new Error('Dosya Excel formatında açılamadı'), { status: 400 });
  }

  const rows = parseCsvBuffer(file.buffer);
  if (!rows.length && ext === 'csv') {
    throw Object.assign(new Error('CSV dosyası okunamadı'), { status: 400 });
  }
  if (!rows.length) {
    throw Object.assign(new Error('Desteklenen format: .xlsx, .xls veya .csv'), { status: 400 });
  }
  return { headers: rows[0] ? Object.keys(rows[0]) : [], rows: rows.slice(0, 5000), file_kind: 'csv' };
}
