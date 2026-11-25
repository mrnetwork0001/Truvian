/**
 * Truvian's documentation at /docs, rendered on the server so every page is
 * complete without JavaScript.
 *
 * One nav source: public/docs/nav.json lists the groups and pages in reading
 * order. The sidebar, the phone drawer, the Previous/Next pager and the
 * Welcome page's reading order all come from it, so adding a page is one
 * line there plus its article in public/docs/pages/<slug>.html.
 *
 *   GET /docs           the Welcome page (slug "")
 *   GET /docs/<slug>    a page; 404 for a slug that is not in nav.json
 *
 * The article files are trusted HTML fragments written for this site. The
 * only browser script, public/docs/docs.js, opens and closes the phone drawer.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export interface DocItem { slug: string; title: string; blurb: string }
export interface DocGroup { label: string; items: DocItem[] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hrefOf = (slug: string) => (slug ? `/docs/${slug}` : '/docs');

export async function loadNav(publicDir: string): Promise<DocGroup[]> {
  const raw = JSON.parse(await readFile(join(publicDir, 'docs', 'nav.json'), 'utf8')) as { groups: DocGroup[] };
  return raw.groups;
}

function sidebar(groups: DocGroup[], active: string): string {
  return groups.map((g) => `
      <div class="dgroup">
        <p class="dgroup-label">${esc(g.label)}</p>
        <ul>${g.items.map((d) => `
          <li><a href="${hrefOf(d.slug)}"${d.slug === active ? ' aria-current="page"' : ''}>${esc(d.title)}</a></li>`).join('')}
        </ul>
      </div>`).join('');
}

function pager(order: DocItem[], i: number): string {
  const prev = order[i - 1];
  const next = order[i + 1];
  const cell = (d: DocItem | undefined, label: string, cls: string) => d
    ? `<a class="pager-${cls}" href="${hrefOf(d.slug)}"><span class="pager-k">${label}</span><span class="pager-t">${esc(d.title)}</span></a>`
    : '<span></span>';
  return `<nav class="pager" aria-label="Pages">${cell(prev, 'Previous', 'prev')}${cell(next, 'Next', 'next')}</nav>`;
}

/** The Welcome page's reading order, from the same nav. */
function readingOrder(order: DocItem[]): string {
  return `<ol class="reading">${order.slice(1).map((d) => `<li><a href="${hrefOf(d.slug)}">${esc(d.title)}</a> <span>${esc(d.blurb)}</span></li>`).join('')}</ol>`;
}

/** The site footer, taken from the landing page so every page shows the same one. */
export async function loadFooter(publicDir: string): Promise<string> {
  try {
    const html = await readFile(join(publicDir, 'index.html'), 'utf8');
    return html.match(/<footer class="site-foot">[\s\S]*?<\/footer>/)?.[0] ?? '';
  } catch {
    return '';
  }
}

export function renderDocsPage(groups: DocGroup[], slug: string, article: string, footer = ''): string | null {
  const order = groups.flatMap((g) => g.items);
  const i = order.findIndex((d) => d.slug === slug);
  if (i < 0) return null;
  const page = order[i]!;
  const body = article.replace('<!--READING-ORDER-->', readingOrder(order));
  const group = groups.find((g) => g.items.includes(page))!;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script>try{if(localStorage.getItem("truvian-theme")==="light")document.documentElement.setAttribute("data-theme","light")}catch(e){}</script>
<meta name="theme-color" content="#0d0c0a">
<meta name="color-scheme" content="dark light">
<title>${esc(page.title)} · Truvian Docs</title>
<meta name="description" content="${esc(page.blurb)}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@1&family=Inter+Tight:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/footer.css">
<link rel="stylesheet" href="/docs/docs.css">
</head>
<body class="docs">
<a class="skip" href="#article">Skip to content</a>
<div class="dgrid" aria-hidden="true"></div>
<header class="dtop">
  <div class="dtop-inner">
    <a class="dbrand" href="/" aria-label="Truvian home"><img src="/brand/truvian-header.png" alt="Truvian Shield" width="588" height="176"></a>
    <span class="ddiv" aria-hidden="true"></span>
    <a class="dlabel" href="/docs">Docs</a>
    <nav class="dlinks" aria-label="Site">
      <a href="/preflight">Desks</a>
      <a href="/resolve">Resolve</a>
      <a href="/api/stats">Stats</a>
      <a href="https://github.com/mrnetwork0001/Truvian" target="_blank" rel="noopener">GitHub</a>
    </nav>
    <button class="theme-toggle" type="button" aria-label="Switch to light mode" aria-pressed="false"></button>
    <button class="burger" id="dburger" type="button" aria-expanded="false" aria-controls="dnav" aria-label="Open the docs menu"><span></span><span></span><span></span></button>
  </div>
</header>
<div class="mbackdrop" id="dbackdrop" aria-hidden="true"></div>
<div class="dwrap">
  <aside class="dside" id="dnav" aria-label="Docs">
    <div class="dside-head">
      <span class="dlabel">Docs</span>
      <button class="dclose" id="dclose" type="button" aria-label="Close the docs menu">Close</button>
    </div>
    ${sidebar(groups, slug)}
    <div class="dside-foot"><a class="dcta" href="/preflight">Open the desks</a></div>
  </aside>
  <main class="dmain" id="article">
    <p class="dcrumb">${esc(group.label)}</p>
    ${body}
    ${pager(order, i)}
  </main>
</div>
${footer}
<script src="/theme.js"></script>
<script src="/docs/docs.js"></script>
</body>
</html>`;
}

export function registerDocsRoutes(app: FastifyInstance, publicDir: string): void {
  const send = async (slug: string, reply: { status: (c: number) => unknown; type: (t: string) => unknown; send: (b: string) => unknown }) => {
    const groups = await loadNav(publicDir);
    const known = groups.some((g) => g.items.some((d) => d.slug === slug));
    let article: string | null = null;
    if (known) {
      try {
        article = await readFile(join(publicDir, 'docs', 'pages', `${slug || 'welcome'}.html`), 'utf8');
      } catch {
        article = null;
      }
    }
    const footer = await loadFooter(publicDir);
    const html = article !== null ? renderDocsPage(groups, slug, article, footer) : null;
    if (!html) {
      reply.status(404);
      reply.type('text/html; charset=utf-8');
      return reply.send(renderDocsPage(groups, '', `<h1>Not <span class="accent">here.</span></h1><p class="lead"><strong>There is no docs page called "${esc(slug)}".</strong> The sidebar lists every page.</p>`, footer)!.replace(/<nav class="pager"[\s\S]*?<\/nav>/, '').replace(/<title>[^<]*<\/title>/, '<title>Not found · Truvian Docs</title>'));
    }
    reply.type('text/html; charset=utf-8');
    return reply.send(html);
  };
  app.get('/docs', async (_req, reply) => send('', reply));
  app.get('/docs/', async (_req, reply) => reply.redirect('/docs', 301));
  // Static assets live next to the pages (docs.css, docs.js, nav.json); anything with a dot is a file.
  app.get('/docs/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (/^[a-z0-9-]+$/.test(slug)) return send(slug, reply);
    try {
      const data = await readFile(join(publicDir, 'docs', slug.replace(/[^a-zA-Z0-9._-]/g, '')));
      const type = slug.endsWith('.css') ? 'text/css; charset=utf-8' : slug.endsWith('.js') ? 'text/javascript; charset=utf-8' : slug.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      reply.type(type);
      return reply.send(data);
    } catch {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'no such route or file' });
    }
  });
}
