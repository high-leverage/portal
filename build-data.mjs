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

  for (const acc of accounts) {
    try {
      const payload = {
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
