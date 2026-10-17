/**
 * 邮箱范围（包内使用，不从入口导出）。不设长度上限，逐个 `@` 扫（#63 评审）。对每个 `@`：
 * - 向左按 `[A-Za-z0-9._%+-]` 扩，遇到上一处匹配的末尾或上一个 `@` 就停；
 * - 向右按 `[A-Za-z0-9.-]` 扩到 `e`，再从左到右扫域名里的每个 `.`（不含紧挨 `@` 的那个）：
 *   `.` 后面连续 2 个及以上字母、且字母后面是文本末尾或不是 `[A-Za-z0-9_]` 的，就是一个合法结束位置，取最后一个。
 * 这和 main 上 `/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g` 的贪婪结束位置一致，左边可能多遮。
 * 每个字符最多被扫常数次，整体线性。
 */
const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]/;
const LETTER = /[A-Za-z]/;
const WORD = /[A-Za-z0-9_]/;

export function emailRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!text.includes("@")) return ranges;
  const n = text.length;
  let floor = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", floor)) {
    let s = at;
    while (s > floor && EMAIL_LOCAL.test(text[s - 1]!)) s--;
    let e = at + 1;
    while (e < n && EMAIL_DOMAIN.test(text[e]!)) e++;
    let end = -1;
    for (let i = at + 2; i < e; i++) {
      if (text[i] !== ".") continue;
      let k = i + 1;
      while (k < e && LETTER.test(text[k]!)) k++;
      if (k - i - 1 >= 2 && (k >= n || !WORD.test(text[k]!))) end = k;
      i = k - 1;
    }
    if (s < at && end > 0) {
      ranges.push([s, end]);
      floor = end;
    } else {
      floor = at + 1;
    }
  }
  return ranges;
}
