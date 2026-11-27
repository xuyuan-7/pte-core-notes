import { createHash } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const files = [
  '42-day-plan.md',
  'grammar-reference.md',
  'question-type-templates.md',
  'write-email-examples.md',
  'recurring-mistakes.md',
  'exam-readiness-checklist.md',
];

const pageIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const initialBatchFilePattern = /^(?:\d{4}-\d{2}-\d{2}|undated)-\d{2}\.md$/;
const newBatchFilePattern = /^batch-[\da-f]{16}\.md$/;
const notesDirectory = new URL('../../notes/', import.meta.url);
const batchDirectory = new URL('vocabulary/', notesDirectory);
const vocabularyIndex = 'vocabulary-and-collocations.md';
const keyFor = id => id.toLowerCase().replaceAll('-', '');

function readConfig(config) {
  const { token, pages, vocabulary } = JSON.parse(config);
  if (typeof token !== 'string' || !/^(?:ntn_|secret_)\w+$/.test(token)) {
    throw new Error('NOTION_SYNC_CONFIG needs a valid Notion integration token.');
  }

  const sources = files.map(file => [file, pages?.[file]]);
  if (sources.some(([, id]) => typeof id !== 'string' || !pageIdPattern.test(id))) {
    throw new Error('NOTION_SYNC_CONFIG needs a page ID for each of the six study files.');
  }
  if (new Set(sources.map(([, id]) => id.toLowerCase())).size !== files.length) {
    throw new Error('Each study file must have a distinct Notion source.');
  }
  if (!pageIdPattern.test(vocabulary?.dataSourceId) || !pageIdPattern.test(vocabulary?.databaseId)) {
    throw new Error('NOTION_SYNC_CONFIG needs the vocabulary database and data source IDs.');
  }
  const existing = Object.entries(vocabulary.existingFiles ?? {});
  if (!existing.length || existing.some(([file, id]) => !initialBatchFilePattern.test(file) || !pageIdPattern.test(id))) {
    throw new Error('NOTION_SYNC_CONFIG needs the filenames and source IDs for the already published batches.');
  }
  const initialFiles = new Map(existing.map(([file, id]) => [keyFor(id), file]));
  if (initialFiles.size !== existing.length) throw new Error('The vocabulary batch IDs must be distinct.');
  return { token, sources, vocabulary, initialFiles };
}

async function fetchNotion(token, endpoint, label, payload) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch('https://api.notion.com/v1/' + endpoint, {
      method: payload ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'Notion-Version': '2026-03-11',
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      await setTimeout(350);
      return response.json();
    }
    if (response.status !== 429 || attempt === 3) {
      throw new Error(label + ': Notion request failed (HTTP ' + response.status + ').');
    }
    const seconds = Number(response.headers.get('retry-after')) || 1;
    await setTimeout(Math.max(1, Math.min(seconds, 30)) * 1000);
  }
}

async function fetchVocabulary(token, dataSourceId, initialFiles) {
  const batches = new Map();
  const cursors = new Set();
  let cursor;
  do {
    const result = await fetchNotion(token, 'data_sources/' + dataSourceId + '/query', 'Vocabulary database', {
      page_size: 100,
      start_cursor: cursor,
    });
    if (!Array.isArray(result.results) || typeof result.has_more !== 'boolean' || result.request_status?.type === 'incomplete') {
      throw new Error('Notion returned an incomplete vocabulary list.');
    }
    for (const page of result.results) {
      if (page.in_trash || page.is_archived || page.archived) continue;
      if (page.object !== 'page' || !pageIdPattern.test(page.id)) {
        throw new Error('The vocabulary database returned an unsupported batch.');
      }
      const id = keyFor(page.id);
      const name = initialFiles.get(id) ?? 'batch-' + createHash('sha256').update(id).digest('hex').slice(0, 16) + '.md';
      const file = 'vocabulary/' + name;
      if (batches.has(file)) throw new Error('Notion returned a duplicate vocabulary batch.');
      batches.set(file, page);
    }
    cursor = undefined;
    if (result.has_more) {
      cursor = result.next_cursor;
      if (!cursor || cursors.has(cursor)) throw new Error('Notion returned an invalid vocabulary cursor.');
      cursors.add(cursor);
    }
  } while (cursor);

  if (!batches.size) throw new Error('Notion returned an empty vocabulary database.');
  return batches;
}

const plainText = parts => (parts ?? []).map(part => part.plain_text).join('');

function pageTitle(page) {
  const title = Object.values(page.properties ?? {}).find(property => property.type === 'title');
  const name = plainText(title?.title).replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A Notion page is missing its title.');
  return name;
}

function convertMarkdown(markdown, links, currentFile) {
  const renderLink = (url, label) => {
    if (!/^https?:\/\//i.test(url)) return label;
    const { hostname, pathname } = new URL(url);
    if (/(^|\.)(notion\.com|notion\.so|notion\.site)$/i.test(hostname)) {
      const pageId = pathname.match(/([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\/?$/i)?.[1];
      const target = pageId && links.get(keyFor(pageId));
      if (!target) return label;
      const relative = posix.relative(posix.dirname(currentFile), target);
      const destination = relative.startsWith('.') ? relative : './' + relative;
      return '[' + label + '](' + destination + ')';
    }
    return '[' + label + '](' + url + ')';
  };

  return markdown
    .replace(/<(mention|page|database|folder)\b[^>]*?\burl="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g, (_, tag, url, label) => {
      const link = renderLink(url, label.trim().replace(/\n+/g, ' '));
      return tag === 'mention' ? link : '- ' + link;
    })
    .replace(/<mention\b[^>]*\/>/g, '')
    .replace(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/(?:[^/]+\.)?(?:notion\.so|notion\.site|notion\.com)\/[^\s()<>]+)\)/gi,
      (_, label, url) => renderLink(url, label))
    .replace(/<date start="([^"]+)"(?: end="([^"]+)")?[^>]*\/>/g,
      (_, start, end) => end ? start + ' — ' + end : start)
    .replace(/<b>([^\n]*?)<\/b>/g, '**$1**')
    .replace(/<i>([^\n]*?)<\/i>/g, '*$1*')
    .replace(/<span\b[^>]*>|<\/span>/g, '')
    .replace(/<(?:table-of-contents|p)\b[^>]*\/>/g, '')
    .replace(/<(callout|quote)\b[^>]*>\n?([\s\S]*?)\n?<\/\1>/g,
      (_, tag, body) => body.split('\n').map(line => line ? '> ' + line : '>').join('\n'))
    .replace(/<toggle\b[^>]*>\n([^\n]+)\n/g,
      (_, title) => '<details>\n<summary>' + title.trim() + '</summary>\n\n')
    .replace(/<\/toggle>/g, '\n</details>')
    .replace(/<todo\b[^>]*\bchecked="(true|false)"[^>]*>\n?([\s\S]*?)<\/todo>/g,
      (_, checked, body) => '- [' + (checked === 'true' ? 'x' : ' ') + '] ' + body.trim().replace(/\n/g, '\n  '))
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g, (_, body) => {
      const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
        [...row.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(([, tag, cell]) =>
          cell.trim().replace(/(?<!\\)\|/g, '\\|').replace(/\n+/g, '<br>'))
      );
      if (!rows[0]?.length || rows.some(row => row.length !== rows[0].length)) {
        throw new Error('A Notion table could not be rendered without dropping cells.');
      }
      const line = row => '| ' + row.join(' | ') + ' |';
      return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
    })
    .trim();
}

async function renderPage(token, id, page, file, links) {
  if (page.archived || page.is_archived || page.in_trash) throw new Error(file + ': the source page is archived.');
  const result = await fetchNotion(token, 'pages/' + id + '/markdown?markdown_version=v2', file);
  if (result.truncated || result.unknown_block_ids?.length || typeof result.markdown !== 'string' || !result.markdown.trim()) {
    throw new Error(file + ': Notion returned an incomplete page. The published copy was preserved.');
  }
  const body = convertMarkdown(result.markdown, links, file);
  if (/<\/?(?:unknown|attachment|bookmark|embed|file|audio|video|pdf|image|meeting-notes|mail|synced-block-reference)\b|notion-file-block:|X-Amz-Signature=|file\.notion\.so\/|secure\.notion-static\.com\//i.test(body)) {
    throw new Error(file + ': contains an attachment or embedded content that requires review before publication.');
  }
  if (/<\/?(?:mention|page|folder|database|toggle|callout|quote|todo|date)\b|https?:\/\/(?:[^/\s]+\.)?(?:notion\.so|notion\.site|notion\.com)\//i.test(body)) {
    throw new Error(file + ': contains a Notion reference that requires review before publication.');
  }
  if (!body) throw new Error(file + ': the rendered page is empty.');

  const icon = page.icon?.type === 'emoji' ? page.icon.emoji + ' ' : '';
  const heading = '# ' + icon + pageTitle(page) + '\n\n';
  const navigation = file.startsWith('vocabulary/') ? '[返回词汇总表](../' + vocabularyIndex + ')\n\n' : '';
  return heading + navigation + body + '\n';
}

const escapeCell = value => String(value ?? '').replace(/(?<!\\)\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
const dateFor = page => page.properties?.['日期']?.date;
const choices = property => (property?.multi_select ?? []).map(option => option.name).join('、');

function renderVocabularyIndex(batches) {
  const sorted = [...batches].sort(([fileA, a], [fileB, b]) =>
    (dateFor(b)?.start ?? '').localeCompare(dateFor(a)?.start ?? '') || fileA.localeCompare(fileB));
  const header = [
    '# PTE Core｜生词与固定搭配唯一总表',
    '',
    '收录 Notion 总表的 ' + batches.size + ' 个批次。点击批次名称查看词汇、固定搭配和复习记录。',
    '',
    '| 批次 | 日期 | 来源 | 状态 | 词条数 | 说明 | 题型 |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
  ];
  const rows = sorted.map(([file, page]) => {
    const p = page.properties;
    const date = dateFor(page);
    const dates = [date?.start, date?.end].filter(Boolean).join(' — ');
    const label = escapeCell(pageTitle(page)).replace(/[\[\]]/g, '\\$&');
    const columns = [dates, choices(p['来源']), p['状态']?.select?.name, p['词条数']?.number,
      plainText(p['说明']?.rich_text), choices(p['题型'])].map(escapeCell);
    return '| [' + label + '](./' + file + ') | ' + columns.join(' | ') + ' |';
  });
  return [...header, ...rows, ''].join('\n');
}

async function sync(config) {
  const { token, sources, vocabulary, initialFiles } = readConfig(config);
  const batches = await fetchVocabulary(token, vocabulary.dataSourceId, initialFiles);
  const links = new Map(sources.map(([file, id]) => [keyFor(id), file]));
  links.set(keyFor(vocabulary.databaseId), vocabularyIndex);
  for (const [file, page] of batches) links.set(keyFor(page.id), file);

  const outputs = new Map([[vocabularyIndex, renderVocabularyIndex(batches)]]);
  for (const [file, id] of sources) {
    const page = await fetchNotion(token, 'pages/' + id, file);
    outputs.set(file, await renderPage(token, id, page, file, links));
  }
  for (const [file, page] of batches) {
    outputs.set(file, await renderPage(token, page.id, page, file, links));
  }

  await mkdir(batchDirectory, { recursive: true });
  for (const [file, content] of outputs) {
    await writeFile(new URL(file, notesDirectory), content);
  }
  const managedFiles = new Set(initialFiles.values());
  for (const file of await readdir(batchDirectory, { withFileTypes: true })) {
    if (file.isFile() && (managedFiles.has(file.name) || newBatchFilePattern.test(file.name)) && !batches.has('vocabulary/' + file.name)) {
      await unlink(new URL(file.name, batchDirectory));
    }
  }
  console.log('Checked ' + sources.length + ' study pages and ' + batches.size + ' vocabulary batches.');
}

try {
  const config = process.env.NOTION_SYNC_CONFIG;
  if (config) {
    await sync(config);
  } else {
    console.log('::notice::Add NOTION_SYNC_CONFIG to enable Notion syncing.');
  }
} catch (error) {
  const message = error instanceof SyntaxError ? 'NOTION_SYNC_CONFIG or Notion returned invalid JSON.' : error.message;
  console.error(message);
  process.exitCode = 1;
}
