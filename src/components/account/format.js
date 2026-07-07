// 账户/会员面板通用格式化工具。金额分→元、字数千分位、日期友好展示。

// 分 → 元（保留两位，整数去零：600 → "6"，1550 → "15.50"）。
export function centsToYuan(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "0";
  const yuan = n / 100;
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}

// 字数千分位（10000 → "10,000"）。null/非数字 → "—"。
export function formatChars(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US");
}

// ISO 日期 → "YYYY-MM-DD"。无效 → 原值或空串。
export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
