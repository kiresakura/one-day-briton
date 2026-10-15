// 試算表匯出的 CSV（RFC 4180）：逗號分欄；含逗號、引號或換行的儲存格用雙引號包住，
// 裡面的引號寫成兩個 ""。開頭可以有 BOM，換行可以是 CRLF、LF 或 CR。

// 回傳每一列的儲存格文字陣列；儲存格內的換行一律變成 \n。
export function parseCsv(text) {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];
  let record = [];
  let field = '';
  let fieldStart = 0;
  let quoted = false;
  let line = 1;
  let quoteLine = 0;
  let index = 0;

  const endRecord = () => {
    record.push(field);
    records.push(record);
    record = [];
    field = '';
  };

  while (index < input.length) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 2;
      } else if (char === '"') {
        quoted = false;
        index += 1;
      } else if (char === '\r' || char === '\n') {
        field += '\n';
        index += char === '\r' && next === '\n' ? 2 : 1;
        line += 1;
      } else {
        field += char;
        index += 1;
      }
    } else if (char === '"' && index === fieldStart) {
      // 只有儲存格一開頭的引號有特別意思；中間的引號照字面保留。
      quoted = true;
      quoteLine = line;
      index += 1;
    } else if (char === ',') {
      record.push(field);
      field = '';
      index += 1;
      fieldStart = index;
    } else if (char === '\r' || char === '\n') {
      endRecord();
      index += char === '\r' && next === '\n' ? 2 : 1;
      line += 1;
      fieldStart = index;
    } else {
      field += char;
      index += 1;
    }
  }
  if (quoted) throw new Error(`引號沒有關閉：第 ${quoteLine} 行開始的儲存格少了結尾的 "`);
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

// 第一列是欄名，之後每列變成 { row, values }：row 是試算表上的列號（欄名那列是第 1 列），
// values 以欄名為鍵、前後空白已去掉。整列空白的略過，列號照算。
export function readTable(text) {
  const [first, ...rest] = parseCsv(text);
  if (!first) throw new Error('檔案是空的');
  const header = first.map((name) => name.normalize('NFKC').trim());
  const seen = new Set();
  for (const name of header) {
    if (name && seen.has(name)) throw new Error(`第一列有重複的欄名「${name}」`);
    seen.add(name);
  }
  const rows = [];
  rest.forEach((cells, position) => {
    if (cells.every((cell) => cell.trim() === '')) return;
    const values = {};
    header.forEach((name, column) => {
      if (name) values[name] = (cells[column] ?? '').trim();
    });
    rows.push({ row: position + 2, values });
  });
  return { header: header.filter(Boolean), rows };
}
