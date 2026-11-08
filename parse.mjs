// Bản rút gọn của lib/parseSheets.js (margin-portal) — chạy trong GitHub Actions.
// Chỉ ĐỌC dữ liệu từ Google Sheet, không bao giờ ghi.

export function toNumber(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return val;
  const cleaned = String(val).replace(/,/g, "").replace(/%/g, "").trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function normalizeName(val) {
  return String(val || "").trim();
}

const NAV_COLS = { name: 0, nav: 1, pnl: 2, debt: 3, portfolioValue: 4, dailyInterest: 5, ratioOrDate: 6 };

export function findNavRealtimeRow(rows, navRowName) {
  const target = normalizeName(navRowName);
  for (const row of rows) {
    if (normalizeName(row[NAV_COLS.name]) === target) {
      return {
        nav: toNumber(row[NAV_COLS.nav]),
        pnl: toNumber(row[NAV_COLS.pnl]),
        debt: toNumber(row[NAV_COLS.debt]),
        portfolioValue: toNumber(row[NAV_COLS.portfolioValue]),
        dailyInterest: toNumber(row[NAV_COLS.dailyInterest]),
        marginRatio: toNumber(row[NAV_COLS.ratioOrDate]),
      };
    }
  }
  return null;
}

function parseVNDate(str) {
  if (!str) return null;
  const parts = String(str).trim().split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map((p) => parseInt(p, 10));
  if (!d || !m || !y) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

export function getNavHistory(rows, navRowName) {
  const target = normalizeName(navRowName);
  const history = [];
  for (const row of rows) {
    if (normalizeName(row[NAV_COLS.name]) !== target) continue;
    const date = parseVNDate(row[NAV_COLS.ratioOrDate]);
    if (!date) continue;
    history.push({
      t: date.getTime(),
      d: String(row[NAV_COLS.ratioOrDate]),
      nav: toNumber(row[NAV_COLS.nav]),
      debt: toNumber(row[NAV_COLS.debt]),
      pv: toNumber(row[NAV_COLS.portfolioValue]),
    });
  }
  history.sort((a, b) => a.t - b.t);
  return history;
}

function makeFinder(grid) {
  return function findCell(labelMatcher) {
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        const cell = normalizeName(grid[r][c]).toLowerCase();
        if (labelMatcher(cell)) return { r, c };
      }
    }
    return null;
  };
}

export function buildApiPriceMap(apiRows) {
  const map = {};
  for (const row of apiRows || []) {
    const code = normalizeName(row[0]);
    if (!code) continue;
    const price = toNumber(row[2]);
    if (price) map[code] = price;
  }
  return map;
}

// Lãi/lỗ theo đúng công thức tab "DESIGN update" của sheet Leverage.
export function parseKeyInHoldingsDesign(rows, customerName, apiPriceMap) {
  const grid = rows || [];
  const target = normalizeName(customerName).toLowerCase();
  if (!target) return [];
  const findCell = makeFinder(grid);
  const custPos = findCell((c) => c.includes("khách hàng"));
  const codePos = findCell((c) => c === "mã");
  if (!custPos || !codePos) return [];

  const custCol = custPos.c;
  const codeCol = codePos.c;
  const volCol = codeCol + 2;
  const costCol = codeCol + 3;
  const statusCol = codeCol + 4;
  const shortCol = codeCol + 23;

  const grouped = {};
  for (let r = custPos.r + 1; r < grid.length; r++) {
    if (normalizeName(grid[r][custCol]).toLowerCase() !== target) continue;
    if (normalizeName(grid[r][statusCol]).toLowerCase() !== "on") continue;
    const code = normalizeName(grid[r][codeCol]);
    if (!code || code === "-") continue;
    if (!grouped[code]) grouped[code] = { code, totalCost: 0, volume: 0, isShort: false };
    grouped[code].totalCost += toNumber(grid[r][costCol]);
    grouped[code].volume += toNumber(grid[r][volCol]);
    if (normalizeName(grid[r][shortCol]).toLowerCase() === "short") grouped[code].isShort = true;
  }

  return Object.values(grouped)
    .filter((h) => h.volume > 0)
    .map((h) => {
      const costPrice = h.totalCost / (h.volume * 1000);
      const marketPrice = ((apiPriceMap && apiPriceMap[h.code]) || 0) / 1000;
      const pnl = h.isShort
        ? (costPrice - marketPrice) * 1000 * h.volume
        : (marketPrice - costPrice) * 1000 * h.volume;
      const pnlPct = h.isShort
        ? marketPrice ? ((costPrice - marketPrice) / marketPrice) * 100 : 0
        : costPrice ? ((marketPrice - costPrice) / costPrice) * 100 : 0;
      return { code: h.code, buyPrice: costPrice, marketPrice, volume: h.volume, pnl, pnlPct, short: h.isShort };
    });
}

export function parseKeyInCapital(rows, customerName) {
  const grid = rows || [];
  const target = normalizeName(customerName).toLowerCase();
  if (!target) return 0;
  const findCell = makeFinder(grid);
  const custPos = findCell((c) => c.includes("khách hàng"));
  if (!custPos) return 0;
  const capitalPos = findCell((c) => c.includes("vốn nộp"));
  const custCol = custPos.c;
  const capitalCol = capitalPos ? capitalPos.c : custCol + 2;
  let total = 0;
  for (let r = custPos.r + 1; r < grid.length; r++) {
    if (normalizeName(grid[r][custCol]).toLowerCase() !== target) continue;
    total += toNumber(grid[r][capitalCol]);
  }
  return total;
}

export function parseKeyInOrders(rows, customerName) {
  const grid = rows || [];
  const target = normalizeName(customerName).toLowerCase();
  if (!target) return [];
  const findCell = makeFinder(grid);
  const custPos = findCell((c) => c.includes("khách hàng"));
  const codePos = findCell((c) => c === "mã");
  if (!custPos || !codePos) return [];

  const custCol = custPos.c;
  const codeCol = codePos.c;
  const buyDateCol = custCol + 1;
  const buyCol = codeCol + 1;
  const volCol = codeCol + 2;
  const totalBuyCol = codeCol + 3;
  const statusCol = codeCol + 4;
  const sellDateCol = codeCol + 5;
  const sellPriceCol = codeCol + 6;
  const totalSellCol = codeCol + 8;
  const finalPnlCol = codeCol + 18;

  const orders = [];
  for (let r = custPos.r + 1; r < grid.length; r++) {
    if (normalizeName(grid[r][custCol]).toLowerCase() !== target) continue;
    const code = normalizeName(grid[r][codeCol]);
    if (!code || code === "-") continue;
    const buyDateLabel = normalizeName(grid[r][buyDateCol]);
    const sellDateLabel = normalizeName(grid[r][sellDateCol]);
    const sellPrice = toNumber(grid[r][sellPriceCol]);
    const bd = parseVNDate(buyDateLabel);
    orders.push({
      code,
      buyDate: buyDateLabel,
      buyT: bd ? bd.getTime() : 0,
      buyPrice: toNumber(grid[r][buyCol]),
      volume: toNumber(grid[r][volCol]),
      totalBuy: toNumber(grid[r][totalBuyCol]),
      status: normalizeName(grid[r][statusCol]).toUpperCase(),
      hasSold: Boolean(sellDateLabel) || sellPrice > 0,
      sellDate: sellDateLabel,
      sellPrice,
      totalSell: toNumber(grid[r][totalSellCol]),
      finalPnl: toNumber(grid[r][finalPnlCol]),
    });
  }
  orders.sort((a, b) => b.buyT - a.buyT);
  return orders;
}
