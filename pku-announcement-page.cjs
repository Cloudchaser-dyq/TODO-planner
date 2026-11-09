'use strict';

// Parse the read-only Blackboard announcement list as text. No page scripts,
// images, frames or attachment links are executed or fetched.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HIDDEN = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'button', 'form']);
function decode(value) {
  const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
  return value.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name) => {
    if (name[0] !== '#') return names[name.toLowerCase()] ?? whole;
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
function tree(html) {
  if (typeof html !== 'string' || html.length > 4 * 1024 * 1024) throw new Error('announcement page limit');
  const root = { tag: '', attrs: {}, children: [] }, stack = [root];
  const lower = html.toLowerCase();
  let at = 0, count = 0;
  while (at < html.length) {
    if (++count > 100000) throw new Error('announcement node limit');
    if (html.startsWith('<!--', at)) { const end = html.indexOf('-->', at + 4); at = end < 0 ? html.length : end + 3; continue; }
    if (html[at] !== '<') {
      const end = html.indexOf('<', at), to = end < 0 ? html.length : end;
      stack.at(-1).children.push(html.slice(at, to)); at = to; continue;
    }
    let end = at + 1, quote = '';
    for (; end < html.length; end++) {
      const ch = html[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (end - at > 16384) throw new Error('announcement tag limit');
    const raw = html.slice(at, end + 1), match = raw.match(/^<\s*(\/?)\s*([a-z][a-z\d:-]*)\b/i);
    at = end + 1;
    if (!match) continue;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    // HTML permits omitted closing tags for list items and paragraphs.
    if (['li', 'p'].includes(tag) && stack.at(-1).tag === tag) stack.pop();
    const attrs = Object.create(null);
    for (const attr of raw.slice(match[0].length).matchAll(/([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      attrs[attr[1].toLowerCase()] = decode(attr[2] ?? attr[3] ?? attr[4]);
    }
    const node = { tag, attrs, children: [] }; stack.at(-1).children.push(node);
    if (['script', 'style', 'iframe', 'noscript', 'template', 'object'].includes(tag)) {
      const close = lower.indexOf('</' + tag, at);
      const closeEnd = close < 0 ? -1 : html.indexOf('>', close);
      at = closeEnd < 0 ? html.length : closeEnd + 1;
      continue;
    }
    if (!VOID.has(tag) && !/\/\s*>$/.test(raw)) {
      if (stack.length >= 200) throw new Error('announcement depth limit');
      stack.push(node);
    }
  }
  return root;
}
function descendants(node, predicate, out = []) {
  if (typeof node === 'string' || HIDDEN.has(node.tag)) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children) descendants(child, predicate, out);
  return out;
}
const hasClass = (node, name) => (node.attrs.class || '').split(/\s+/).includes(name);
function text(node) {
  if (typeof node === 'string') return decode(node);
  if (HIDDEN.has(node.tag)) return '';
  const result = node.children.map(text).join('');
  return ['p', 'div', 'br', 'li', 'h3', 'h4', 'tr'].includes(node.tag) ? '\n' + result + '\n' : result;
}
function normalize(value, max) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, max);
}
function publishedDate(nodes) {
  function datedText(node) {
    if (typeof node === 'string') return decode(node);
    if (HIDDEN.has(node.tag)) return '';
    if (node.tag === 'time' && node.attrs.datetime) return node.attrs.datetime;
    return node.children.map(datedText).join(' ');
  }
  for (const node of nodes) {
    const value = datedText(node);
    const label = value.match(/发布时间|发布日期|发布于|发表于|posted\s+(?:on|at)|published(?:\s+on)?\s*[:：]/i);
    if (!label) continue;
    const relevant = value.slice(label.index + label[0].length).replace(/^[\s:：]+/, '');
    const explicit = relevant.match(/^(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)(?![\d:])/i);
    if (explicit) return explicit[1];
    const m = relevant.match(/^(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    const english = relevant.match(/^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
    if (english) {
      const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(english[1].toLowerCase()) + 1;
      return english[3] + '-' + String(month).padStart(2, '0') + '-' + english[2].padStart(2, '0');
    }
  }
  return null;
}
function parseAnnouncementPage(html) {
  const root = tree(html);
  const list = descendants(root, node => node.attrs.id === 'announcementList')[0];
  if (!list) return { recognized: false, items: [], skipped: 0 };
  const rows = list.children.filter(node => typeof node !== 'string' && node.tag === 'li');
  if (!rows.length && normalize(text(list), 1000)) return { recognized: false, items: [], skipped: 0 };
  const items = []; let skipped = 0;
  for (const row of rows.slice(0, 300)) {
    const heading = descendants(row, node => node.tag === 'h3')[0];
    const details = descendants(row, node => hasClass(node, 'details'))[0];
    if (!heading || !details) { skipped++; continue; }
    const title = normalize(text(heading), 200), body = normalize(text(details), 50001);
    if (body.length > 50000) { skipped++; continue; }
    if (!title || !body) { skipped++; continue; }
    const metadata = descendants(row, node => hasClass(node, 'announcementInfo'));
    const firstParagraph = details.children.find(node => typeof node !== 'string' && node.tag === 'p');
    if (firstParagraph) metadata.push(firstParagraph);
    const rawId = row.attrs.id || row.attrs['data-announcement-id'];
    const id = typeof rawId === 'string' && /^[\w:.-]{1,200}$/.test(rawId) ? rawId : '';
    items.push({ id, title, body, publishedAt: publishedDate(metadata) });
  }
  // Pagination is not followed speculatively: callers disclose the current-page
  // scope instead of sending requests to arbitrary links in announcement HTML.
  return { recognized: true, items, skipped: skipped + Math.max(0, rows.length - 300) };
}

function parseCurrentCourses(html) {
  const root = tree(html);
  const portlets = descendants(root, node => hasClass(node, 'portlet'));
  const current = portlets.filter(node => descendants(node, n => hasClass(n, 'moduleTitle')).some(n => /当前|\bcurrent\b/i.test(text(n))));
  const courses = new Map();
  let recognized = false, skipped = 0;
  for (const portlet of current) {
    const listings = descendants(portlet, node => node.tag === 'ul' && hasClass(node, 'courseListing'));
    if (listings.length) recognized = true;
    for (const listing of listings) {
      const links = descendants(listing, node => node.tag === 'a');
      if (!links.length && normalize(text(listing), 1000)) skipped++;
      for (const link of links) {
      let url;
      try { url = new URL(link.attrs.href || '', 'https://course.pku.edu.cn'); } catch { skipped++; continue; }
      if (url.origin !== 'https://course.pku.edu.cn' || url.username || url.password) { skipped++; continue; }
      const key = url.searchParams.get('key');
      const id = key?.match(/^(_\d+_\d+),/)?.[1] || (url.pathname === '/webapps/blackboard/execute/launcher' && url.searchParams.get('type') === 'Course' ? url.searchParams.get('id') : '');
      if (!/^_\d+_\d+$/.test(id || '')) { skipped++; continue; }
      const name = normalize(text(link), 200);
      if (name) courses.set(id, { id, name });
      }
    }
  }
  return { recognized: recognized && !(skipped && !courses.size), courses: [...courses.values()], skipped };
}

module.exports = { parseAnnouncementPage, parseCurrentCourses };
