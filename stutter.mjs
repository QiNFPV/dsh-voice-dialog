// 语音识别的口吃折叠：只在“明显是重复”的位置动手，尽量不碰正常的中文叠词。
//
// 规则（只处理汉字，数字 / 英文 / 标点一律不动）：
//   1. 同一个汉字连续出现 ≥3 次 → 收成 1 个         来来来来 → 来
//   2. 同一个双字单元连续出现 ≥2 次 → 收成 1 个      测试测试测试 → 测试
//
// 刻意保留的：
//   - 2 个字的叠词（看看 / 谢谢 / 慢慢 / 好好）—— 正常说法，不是口吃
//   - 笑声（哈哈哈 / 嘿嘿嘿）—— 收成一个反而怪
const LAUGH = new Set(['哈', '嘿', '呵', '嘻', '嘎']);

export function collapseStutter(input) {
  let s = String(input == null ? '' : input);
  if (!s) return s;
  s = s.replace(/([\u4e00-\u9fff])\1{2,}/g, (run, ch) => (LAUGH.has(ch) ? run : ch));
  s = s.replace(/([\u4e00-\u9fff]{2})\1+/g, '$1');
  return s;
}

export default collapseStutter;
