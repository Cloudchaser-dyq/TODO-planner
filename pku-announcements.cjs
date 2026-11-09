'use strict';

// Local text extraction only: callers supply plain announcement text. No
// credentials, network access, AI service, or persistence is used here.
const DAY = 86400000;
const LIMIT = 50000;
const MAX_ITEMS = 30;
const CUE = /截止|最迟|最晚|提交|上交|递交|交(?:作业|报告|论文|材料|文件|齐|卷)|(?:日|号)(?:前|之前|以内)[^,，。；;\n]{0,40}完成|\b(?:ddl|deadline|due|submit)\b/i;
const STRONG_CUE = /截止|最迟|最晚|\b(?:ddl|deadline|due)\b/i;
const HEADING = /(?:截止(?:时间|日期)?|ddl|deadline|due(?:\s+date)?)(?:\s*如下)?\s*[:：]?\s*$/i;
const NON_DUE = /发布(?:时间|日期)?|公告时间|更新于|发布日期|开课|开始上课|上课时间|考试时间|开考|讲座时间|活动时间|开放提交|开始提交|提交开放|(?:开放|开始).*?(?:提交|上传)|\b(?:posted|published|opens?|starts?)\b/i;
const FIXED_EVENT = /考试|上课|开课|开考|讲座/;
const DELIVERABLE = /提交|上交|递交|交(?:作业|报告|论文|材料|文件|齐|卷)|报名|注册|申请|\bsubmit\b/i;
const REVISED = /延期(?:至|到)?|延后(?:至|到)?|推迟(?:至|到)?|顺延(?:至|到)?|改为|改至|调整(?:为|至)|改到|延长(?:至|到)|\b(?:extended\s+to|moved\s+to|postponed\s+to)\b/gi;
const FUZ = /本周末|下周末|周末|月底|月末|下下周(?![一二三四五六日天1-7])|下周(?![一二三四五六日天1-7])|课前|上课前|下课前|课后|期末|尽快|近期|另行通知|待定|待通知|[一二三四五六七八九十两\d]+天内|\basap\b/i;
const TOKENS = /(?<!\d)(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?!\d)\s*[日号]?|(?<![\d/.-])(\d{1,2})\s*月\s*(\d{1,2})(?!\d)\s*[日号]?|(?<![\d/.-])(\d{1,2})\s*[/-]\s*(\d{1,2})(?![\d/-])|大后天|后天|明天|今天|今日|明日|后日|今晚|明晚|(?:下下|本|这|下)(?:周|星期)[一二三四五六日天1-7]|(?:周|星期)[一二三四五六日天1-7]/g;

function text(value, length) {
  return typeof value === 'string' ? value.slice(0, length).normalize('NFKC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, length) : '';
}
function dateText(epoch) { return new Date(epoch).toISOString().slice(0, 10); }
function calendarDate(year, month, day) {
  if (!Number.isInteger(year) || year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = Date.UTC(year, month - 1, day);
  return new Date(value).getUTCMonth() === month - 1 && new Date(value).getUTCDate() === day ? value : null;
}
function publicationDate(value) {
  if (typeof value !== 'string') return null;
  value = value.trim();
  const m = value.match(/^(20\d{2})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (!m || calendarDate(+m[1], +m[2], +m[3]) == null || +(m[4] || 0) > 23 || +(m[5] || 0) > 59 || +(m[6] || 0) > 59) return null;
  if (!m[4]) return calendarDate(+m[1], +m[2], +m[3]);
  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2') + (m[7] ? '' : '+08:00');
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) return null;
  const local = new Date(epoch + 8 * 3600000);
  return calendarDate(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
}
function resolveDate(token, published) {
  const m = token.match;
  if (m[1]) {
    const epoch = calendarDate(+m[1], +m[2], +m[3]);
    return epoch == null ? { due: '', notes: ['原文日期无效，请手动核对。'] } : { due: dateText(epoch), notes: [] };
  }
  const month = +(m[4] || m[6] || 0), day = +(m[5] || m[7] || 0);
  if (m[4] !== undefined || m[6] !== undefined) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return { due: '', notes: ['原文日期无效，请手动核对。'] };
    if (published == null) return { due: '', notes: ['原文未写年份，且公告发布日期不明，请补全日期。'] };
    const base = new Date(published);
    let year = base.getUTCFullYear();
    if (base.getUTCMonth() >= 9 && month <= 3) year++;
    else if (base.getUTCMonth() <= 2 && month >= 10) year--;
    const epoch = calendarDate(year, month, day);
    return epoch == null ? { due: '', notes: ['原文日期无效，请手动核对。'] } : { due: dateText(epoch), notes: ['年份按公告发布日期推断为 ' + year + ' 年，请核对。'] };
  }
  if (published == null) return { due: '', notes: ['相对日期缺少可靠的公告发布日期，请补全日期。'] };
  const relative = m[0];
  const offsets = { 今天: 0, 今日: 0, 今晚: 0, 明天: 1, 明日: 1, 明晚: 1, 后天: 2, 后日: 2, 大后天: 3 };
  if (Object.hasOwn(offsets, relative)) return { due: dateText(published + offsets[relative] * DAY), notes: ['相对日期按公告发布日 ' + dateText(published) + ' 推算，请核对。'] };
  const week = relative.match(/^(下下|本|这|下)(?:周|星期)([一二三四五六日天1-7])$/);
  if (!week) return { due: '', notes: ['星期未明确是哪一周，请补全日期。'] };
  const weekday = '一二三四五六日'.indexOf(week[2]) + 1 || (week[2] === '天' ? 7 : +week[2]);
  const baseDay = new Date(published).getUTCDay() || 7;
  const weeks = week[1] === '下下' ? 2 : week[1] === '下' ? 1 : 0;
  return { due: dateText(published + (weekday - baseDay + weeks * 7) * DAY), notes: ['相对日期按公告发布日 ' + dateText(published) + ' 推算，请核对。'] };
}
function chineseNumber(value) {
  if (/^\d+$/.test(value)) return +value;
  if (value === '两') return 2;
  const digits = '零一二三四五六七八九';
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [a, b] = value.split('十');
    if ((a && digits.indexOf(a) < 1) || (b && digits.indexOf(b) < 0)) return NaN;
    return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0);
  }
  return digits.indexOf(value);
}
function attachTime(resolved, tail, relativeWord) {
  const m = tail.match(/^[\sT]*(?:[（(](?:周|星期)[一二三四五六日天1-7][）)]\s*)?(?:的|当天|当日)?[，,]?\s*(?:(上午|早上|中午|下午|傍晚|晚上|晚间|凌晨)\s*)?(\d{1,2}|[一二三四五六七八九十两]{1,3})\s*(?::(\d{2})|点(?:\s*(半|一刻|三刻|\d{1,2}|[一二三四五六七八九十两]{1,3})\s*分?)?)(?!\d)/);
  if (!m || !resolved.due) return resolved;
  let hour = chineseNumber(m[2]), minute = m[3] ? +m[3] : m[4] === '半' ? 30 : m[4] === '一刻' ? 15 : m[4] === '三刻' ? 45 : m[4] ? chineseNumber(m[4]) : 0;
  const period = m[1] || (/晚/.test(relativeWord) ? '晚上' : '');
  if (minute < 0 || minute > 59 || hour < 0 || hour > 24 || (hour === 24 && minute !== 0)) {
    resolved.notes.push('原文时刻无效，请补全具体时刻。'); return resolved;
  }
  if (period) {
    if (hour > 12 || ((period === '晚上' || period === '晚间' || period === '傍晚') && hour === 12)) {
      resolved.notes.push('原文时段与时刻需核对，请补全具体时刻。'); return resolved;
    }
    if (['下午', '傍晚', '晚上', '晚间'].includes(period) && hour < 12) hour += 12;
    else if (period === '凌晨' && hour === 12) hour = 0;
    else if (period === '中午' && hour < 11) { resolved.notes.push('原文中午时刻需核对，请补全具体时刻。'); return resolved; }
  } else if (!m[3] && hour >= 1 && hour <= 12) {
    resolved.notes.push('原文未明确上午或下午，请补全具体时刻。'); return resolved;
  }
  if (/\b(?:UTC|GMT|[AP]M)\b|[+-]\d{2}:?\d{2}/i.test(tail.slice(0, 60))) {
    resolved.notes.push('原文包含时区或其他时制，请手动核对具体时刻。'); return resolved;
  }
  if (hour === 24) {
    resolved.due = dateText(Date.parse(resolved.due + 'T00:00:00Z') + DAY); hour = 0;
    resolved.notes.push('24:00 按次日 00:00 显示，请核对。');
  }
  resolved.due += 'T' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  return resolved;
}
function snippet(sentence, at) {
  if (sentence.length <= 1200) return sentence;
  const start = Math.max(0, Math.min(at - 400, sentence.length - 1198));
  return (start ? '…' : '') + sentence.slice(start, start + 1198) + (start + 1198 < sentence.length ? '…' : '');
}

function extractDeadlines({ title = '', body = '', publishedAt } = {}) {
  const heading = text(title, 300).trim();
  let content = text(body, LIMIT).trim();
  if (typeof body === 'string' && body.length > LIMIT) content = content.replace(/[^。!?！？;；\r\n]*$/, '');
  const published = publicationDate(publishedAt);
  const sentences = (heading + '\n' + content).split(/[。!?！？;；\r\n]/).map(value => value.trim());
  const results = [], seen = new Set();
  let carryHeading = false;
  for (const sentence of sentences) {
    if (!sentence) { carryHeading = false; continue; }
    const fromHeading = carryHeading;
    const inheritedCue = carryHeading || STRONG_CUE.test(heading);
    carryHeading = HEADING.test(sentence);
    if (!CUE.test(sentence) && !inheritedCue) continue;
    const tokens = [...sentence.matchAll(TOKENS)].slice(0, 60).map(match => ({ match, at: match.index, end: match.index + match[0].length }))
      .filter(token => !/^(?:周|星期)/.test(token.match[0]) || sentence[token.at - 1] !== '(' || sentence[token.end] !== ')');
    if (fromHeading && tokens.length && !NON_DUE.test(sentence) && !FIXED_EVENT.test(sentence)) carryHeading = true;
    const clauses = [...sentence.matchAll(/[^,，]+/g)].map(match => ({ text: match[0], at: match.index, end: match.index + match[0].length }));
    const revisedTokens = new Set(), replacedTokens = new Set();
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      const revisions = [...clause.text.matchAll(REVISED)];
      if (!revisions.length) continue;
      const revision = revisions[revisions.length - 1];
      const after = tokens.filter(token => token.at >= clause.at + revision.index + revision[0].length && token.at < clause.end);
      if (!after.length) continue;
      after.forEach(token => revisedTokens.add(token));
      tokens.filter(token => token.at >= clause.at && token.at < after[0].at).forEach(token => replacedTokens.add(token));
      // An explicitly labelled old deadline can precede the replacement in
      // the previous clause; independent deadlines in other clauses survive.
      const previous = clauses[i - 1];
      if (previous && /原定|原为|原(?:截止|计划)|此前|之前/.test(previous.text)) {
        tokens.filter(token => token.at >= previous.at && token.at < previous.end).forEach(token => replacedTokens.add(token));
      }
    }
    let eligible = tokens.filter(token => !replacedTokens.has(token));
    // A submission window has a start and an end; its end is the DDL.
    eligible = eligible.filter((token, i, all) => {
      const next = all[i + 1];
      return !next || !/^\s*(?:至|到|[-~—])\s*$/.test(sentence.slice(token.end, next.at));
    });
    let added = false;
    for (const token of eligible) {
      const clause = clauses.find(value => token.at >= value.at && token.at < value.end).text;
      if (!CUE.test(clause) && !inheritedCue && !revisedTokens.has(token)) continue;
      if (NON_DUE.test(clause) && !STRONG_CUE.test(clause)) continue;
      if (FIXED_EVENT.test(clause) && !DELIVERABLE.test(clause)) continue;
      let resolved = resolveDate(token, published);
      const nextDate = tokens.find(next => next.at >= token.end);
      const tail = sentence.slice(token.end, Math.min(nextDate ? nextDate.at : sentence.length, token.end + 80));
      resolved = attachTime(resolved, tail, token.match[0]);
      if (revisedTokens.has(token)) resolved.notes.push('原文调整了截止日期，已取调整后的日期，请核对。');
      if (/取消|另行通知|不再/.test(sentence) && !revisedTokens.has(token)) {
        resolved = { due: '', notes: ['原文提到取消或另行通知，请确认有效的截止日期。'] };
      }
      const excerpt = snippet(sentence, token.at);
      const key = resolved.due + '\0' + excerpt;
      if (!seen.has(key)) {
        seen.add(key); results.push({ due: resolved.due, excerpt, dateNote: resolved.notes.join(' ').slice(0, 200) });
      }
      added = true;
      if (results.length >= MAX_ITEMS) return results;
    }
    const fuzzy = sentence.match(FUZ);
    const timeOnly = sentence.match(/\d{1,2}:\d{2}|[一二三四五六七八九十两\d]{1,3}点/);
    if (!added && (CUE.test(sentence) || inheritedCue) && (fuzzy || timeOnly) && (!NON_DUE.test(sentence) || STRONG_CUE.test(sentence)) && (!FIXED_EVENT.test(sentence) || DELIVERABLE.test(sentence))) {
      const excerpt = snippet(sentence, (fuzzy || timeOnly).index);
      if (!seen.has('\0' + excerpt)) {
        seen.add('\0' + excerpt); results.push({ due: '', excerpt, dateNote: fuzzy ? '原文只有模糊期限，请确认并补全日期。' : '原文只有时刻，请确认并补全日期。' });
      }
      if (results.length >= MAX_ITEMS) return results;
    }
  }
  return results;
}

module.exports = { extractDeadlines };
