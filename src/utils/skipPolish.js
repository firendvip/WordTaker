// 短句优化判据：识别结果"够短且看起来已干净"时跳过 AI 润色、直接贴原文，省一次 LLM 往返。
// 标准：去空白后 ≤ maxChars 个字，且不含口语填充词 / 3+ 连续叠字(口吃)。

// 命中则即使很短也仍走润色
const FILLER_RE = /呃|嗯|那个|内个|就是|然后|啊这|额|(.)\1\1/;

export function shouldSkipPolish(text, maxChars = 6) {
  const t = (text || "").trim();
  if (!t) return false;
  if (maxChars <= 0) return false; // 0=关闭短句优化
  if ([...t].length > maxChars) return false; // 展开计字，兼容 emoji/复合字符
  if (FILLER_RE.test(t)) return false;
  return true;
}
