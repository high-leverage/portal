// Đọc Google Sheet "Leverage" (CHỈ ĐỌC) và xuất file dữ liệu đã MÃ HÓA cho từng khách.
// Chạy trong GitHub Actions, kết quả nằm ở site/data/<hash>.json
//
// Biến môi trường (đặt trong GitHub > Settings > Secrets):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
//   PORTAL_ACCOUNTS  — mỗi dòng: tênđăngnhập|Tên trong sheet|matkhau
//   MASTER_SHEET_ID  — (tùy chọn)

import { google } from "googleapis";
import { webcrypto as crypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  findNavRealtimeRow,
  getNavHistory,
  parseKeyInCapital,
  parseKeyInOrders,
  parseKeyInHoldingsDesign,
  buildApiPriceMap,
} from "./parse.mjs";

const SITE_SALT = "kafi-portal-v1"; // phải giống hệt trong site/index.html
const ITERATIONS = 310000;
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID || "1N5Len0S4vxZrzksnZJDImF6rK6--G8YEMPLbbYmmKvs";

const enc = new TextEncoder();
const hex = (buf) => Buffer.from(buf).toString("hex");
const b64 = (buf) => Buffer.from(buf).toString("base64");

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function fileNameFor(username) {
  return hex(await sha256(`${SITE_SALT}:file:${username}`)).slice(0, 32);
}

async function deriveKey(username, password) {
  const salt = await sha256(`${SITE_SALT}:salt:${username}`);
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

async function encryptJson(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) throw new Error("Thiếu GOOGLE_SERVICE_ACCOUNT_EMAIL hoặc GOOGLE_PRIVATE_KEY");
  key = key.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getValues(sheets, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return res.data.values || [];
}

// ---------- Cổ tức: đọc từ cotuc.vn (chỉ đọc), lưu cache giữa các lần chạy ----------
const WATCH_CODES = ["MWG", "SHS", "MSN", "VIB", "VPB", "MSB", "NLG", "KDH", "FPT", "MBB", "VNM", "VCB", "VIX", "CMG", "MBS", "TPB", "STB", "LPB", "NAB", "DGW", "CTS", "ORS", "BID", "HDB"];
const DIV_CACHE = path.join("cache", "dividends.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDividendHtml(html, dateStr) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(`<a[^>]+href="/en/events/${dateStr}/([^"]+)"[^>]*>([\\s\\S]*?)</a>`, "g");
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (!/Rate/.test(text) || seen.has(slug)) continue;
    seen.add(slug);
    const code = slug.split("-")[0].toUpperCase();
    const before = text.split(/Rate/)[0];
    const type = /\bCash\b/.test(before) ? "Tiền mặt" : /\b(Stock|Bonus|Share)/.test(before) ? "Cổ phiếu" : "Khác";
    const rate = (text.match(/Rate\s+([^\s]+)/) || [])[1] || "";
    const amt = (before.match(/\+?([\d,]+)\s*VND\/share/) || [])[1];
    const ratio = type === "Tiền mặt" && amt ? `${rate} (${Number(amt.replace(/,/g, "")).toLocaleString("vi-VN")}đ/CP)` : rate;
    const pay = text.match(/Payment\s+(\d{2})\/(\d{2})\/(\d{4})/);
    out.push({ code, type, ratio, exDate: dateStr, payDate: pay ? `${pay[3]}-${pay[1]}-${pay[2]}` : null });
  }
  return out;
}

async function fetchDividends(codes) {
  let store = { fetched: {}, events: {} }; // events: { "YYYY-MM-DD": [...] }
  try { store = JSON.parse(fs.readFileSync(DIV_CACHE, "utf8")); } catch (e) { /* chưa có cache */ }
  const vnNow = new Date(Date.now() + 7 * 3600 * 1000);
  const today = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate());
  const isFriday = vnNow.getUTCDay() === 5;
  const refresh = process.env.GITHUB_EVENT_NAME !== "schedule" || isFriday || Object.keys(store.fetched).length === 0;
  const days = [];
  for (let off = -185; off <= 28; off++) {
    const t = today + off * 86400000;
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ds = new Date(t).toISOString().slice(0, 10);
    const recent = off >= -3; // ngày gần/tương lai: tải lại khi refresh
    if (store.fetched[ds] && !(refresh && recent)) continue;
    if (!store.fetched[ds] || refresh) days.push(ds);
  }
  let okCount = 0, failCount = 0;
  for (let i = 0; i < days.length; i += 6) {
    await Promise.all(days.slice(i, i + 6).map(async (ds) => {
      try {
        const res = await fetch(`https://cotuc.vn/en/events/${ds}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; LeveragePortal/1.0)" } });
        if (!res.ok) { failCount++; return; }
        store.events[ds] = parseDividendHtml(await res.text(), ds);
        store.fetched[ds] = true;
        okCount++;
      } catch (e) { failCount++; }
    }));
    await sleep(200);
  }
  console.log(`Cổ tức: tải ${okCount} ngày, lỗi ${failCount} ngày`);
  fs.mkdirSync("cache", { recursive: true });
  fs.writeFileSync(DIV_CACHE, JSON.stringify(store));
  if (Object.keys(store.fetched).length === 0) return null; // không có dữ liệu -> web dùng danh sách dự phòng
  const all = Object.values(store.events).flat();
  return all.filter((e) => codes.has(e.code));
}

function parseAccounts() {
  const raw = process.env.PORTAL_ACCOUNTS || "";
  const accounts = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("|");
    if (parts.length < 3) {
      console.warn("Bỏ qua dòng sai định dạng (cần user|tên sheet|mật khẩu)");
      continue;
    }
    const username = parts[0].trim().toLowerCase();
    const dataName = parts[1].trim();
    const password = parts.slice(2).join("|");
    accounts.push({ username, dataName, password });
  }
  return accounts;
}

async function main() {
  const accounts = parseAccounts();
  if (accounts.length === 0) throw new Error("PORTAL_ACCOUNTS trống");

  const sheets = getSheetsClient();
  const [realtimeRows, batchRows, keyInRows, apiRows] = await Promise.all([
    getValues(sheets, "NAV - Real Time!A1:H500"),
    getValues(sheets, "NAV - Batch!A1:G200000"),
    getValues(sheets, "Key in!A1:AP30000"),
    getValues(sheets, "API!A1:C2000"),
  ]);
  const priceMap = buildApiPriceMap(apiRows);

  const outDir = path.join("site", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync("index.html", path.join("site", "index.html"));
  if (fs.existsSync("logo.png")) fs.copyFileSync("logo.png", path.join("site", "logo.png"));
  const updatedAt = new Date().toISOString();
  let ok = 0;

  // Gộp mã của mọi khách + danh sách theo dõi rồi lấy cổ tức 1 lần
  const allCodes = new Set(WATCH_CODES);
  for (const acc of accounts) {
    try { parseKeyInHoldingsDesign(keyInRows, acc.dataName, priceMap).forEach((h) => allCodes.add(String(h.code).toUpperCase())); } catch (e) { /* bỏ qua */ }
  }
  let dividends = null;
  try { dividends = await fetchDividends(allCodes); } catch (e) { console.error("Không lấy được cổ tức:", e.message); }

  for (const acc of accounts) {
    try {
      const payload = {
        dividends,
        updatedAt,
        name: acc.dataName,
        realtime: findNavRealtimeRow(realtimeRows, acc.dataName),
        history: getNavHistory(batchRows, acc.dataName),
        totalCapital: parseKeyInCapital(keyInRows, acc.dataName),
        holdings: parseKeyInHoldingsDesign(keyInRows, acc.dataName, priceMap),
        orders: parseKeyInOrders(keyInRows, acc.dataName),
      };
      const key = await deriveKey(acc.username, acc.password);
      const file = await fileNameFor(acc.username);
      fs.writeFileSync(path.join(outDir, `${file}.json`), JSON.stringify(await encryptJson(key, payload)));
      ok++;
    } catch (err) {
      console.error(`Lỗi với 1 tài khoản: ${err.message}`);
    }
  }
  console.log(`Đã xuất ${ok}/${accounts.length} tài khoản lúc ${updatedAt}`);
  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
