/**
 * Server-rendered public trip page.
 *
 * TECHNICAL_DESIGN §8.7 / FR-SHARE-02, 09, 10.
 *
 * Deliberately a plain template function with inlined CSS and no client-side
 * JavaScript. Three reasons:
 *   • It must not depend on the (undecided) frontend — a share link has to keep
 *     working regardless of what the client app becomes, or is rewritten into.
 *   • It is the page strangers see, and the primary organic acquisition
 *     surface, so it must be fast on a phone.
 *   • Zero dependencies means zero supply chain on a public, unauthenticated
 *     endpoint.
 */

import type { PublicTripView } from './sharing.service';

/** Every interpolated value is user content. Escaped without exception. */
function esc(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TYPE_GLYPH: Record<string, string> = {
  ACTIVITY: '◆', ACCOMMODATION: '⌂', TRANSPORT: '→', RESTAURANT: '◇',
  TICKET: '▤', PHOTO: '▣', VIDEO: '▸', LINK: '↗', MAP_PIN: '◉',
  NOTE: '✎', BUDGET: '¤',
};

export interface PageOptions {
  readonly view: PublicTripView;
  readonly ownerName: string;
  readonly canonicalUrl: string;
  readonly comments?: { id: string; blockId: string | null; body: string; authorName: string }[];
}

export function renderPublicPage(options: PageOptions): string {
  const { view, ownerName, canonicalUrl } = options;
  const description = `${view.destination} · ${view.dateRangeLabel} · ${view.days.length} days planned on Wandrly`;

  const commentsByBlock = new Map<string, typeof options.comments>();
  for (const comment of options.comments ?? []) {
    if (!comment.blockId) continue;
    const list = commentsByBlock.get(comment.blockId) ?? [];
    list.push(comment);
    commentsByBlock.set(comment.blockId, list);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(view.title)} · Wandrly</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonicalUrl)}">

<!-- Link previews are the acquisition channel: these tags do the marketing. -->
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(view.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonicalUrl)}">
<meta property="og:site_name" content="Wandrly">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(view.title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="robots" content="noindex,nofollow">

<style>
  :root{--bg:#0A0B0E;--surface:#12141A;--surface2:#191C23;--text:#F2F3F5;
        --text2:#9AA0AA;--text3:#5E6570;--border:#23262E;--accent:#F0A05A}
  @media(prefers-color-scheme:light){
    :root{--bg:#F2F3F6;--surface:#FFF;--surface2:#EDEFF3;--text:#15171C;
          --text2:#5C6470;--text3:#969DA8;--border:#E2E5EA;--accent:#D0703F}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);line-height:1.5;font-size:15px;
       font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
       -webkit-font-smoothing:antialiased}
  .wrap{max-width:680px;margin:0 auto;padding:0 20px 72px}
  .hero{background:linear-gradient(135deg,
        oklch(0.38 0.12 ${view.coverHue}),oklch(0.22 0.06 ${view.coverHue2}));
        color:#fff;padding:56px 20px;margin-bottom:32px}
  .hero-inner{max-width:680px;margin:0 auto}
  .eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;
           opacity:.85;margin-bottom:10px}
  h1{font-size:clamp(28px,6vw,42px);line-height:1.15;font-weight:600}
  .sub{margin-top:10px;opacity:.9}
  .day{margin:36px 0 0;border-top:1px solid var(--border);padding-top:22px}
  .day-num{font-size:11px;letter-spacing:.12em;color:var(--accent);font-weight:600}
  .day-title{font-size:19px;font-weight:600;margin-top:4px}
  .day-note{color:var(--text2);font-style:italic;margin-top:4px;font-size:14px}
  .block{display:flex;gap:12px;padding:13px 0;border-bottom:1px solid var(--border)}
  .block:last-child{border-bottom:0}
  .glyph{flex:0 0 26px;height:26px;border-radius:7px;background:var(--surface2);
         display:grid;place-items:center;color:var(--accent);font-size:13px}
  .b-title{font-weight:550}
  .b-meta{color:var(--text2);font-size:13px;margin-top:2px}
  .b-time{color:var(--text3);font-size:12px;font-variant-numeric:tabular-nums}
  .booked{color:#5FBE8B;font-size:12px}
  .cmt{margin-top:8px;padding:8px 11px;background:var(--surface2);
       border-radius:8px;font-size:13px}
  .cmt b{color:var(--accent);font-weight:600}
  a{color:var(--accent)}
  .cta{margin-top:56px;padding:26px;background:var(--surface);
       border:1px solid var(--border);border-radius:14px;text-align:center}
  .cta a{display:inline-block;margin-top:12px;background:var(--accent);color:#fff;
         padding:11px 22px;border-radius:9px;text-decoration:none;font-weight:600}
  footer{margin-top:40px;color:var(--text3);font-size:12px;text-align:center}
</style>
</head>
<body>
<header class="hero">
  <div class="hero-inner">
    <div class="eyebrow">${esc(view.destination)} · ${esc(view.dateRangeLabel)}</div>
    <h1>${esc(view.title)}</h1>
    ${view.subtitle ? `<p class="sub">${esc(view.subtitle)}</p>` : ''}
    <p class="sub" style="font-size:13px;opacity:.75;margin-top:14px">
      Shared by ${esc(ownerName)} · ${view.days.length} day${view.days.length === 1 ? '' : 's'}
    </p>
  </div>
</header>

<main class="wrap">
${view.days
  .map(
    (day) => `
  <section class="day">
    <div class="day-num">DAY ${String(day.dayNumber).padStart(2, '0')}${day.date ? ` · ${esc(day.date)}` : ''}</div>
    ${day.title ? `<h2 class="day-title">${esc(day.title)}</h2>` : ''}
    ${day.note ? `<p class="day-note">${esc(day.note)}</p>` : ''}
    ${
      day.blocks.length === 0
        ? '<p class="b-meta" style="padding:12px 0">Nothing planned yet.</p>'
        : day.blocks
            .map((block) => {
              const blockComments = commentsByBlock.get(block.id) ?? [];
              return `
      <article class="block">
        <span class="glyph">${TYPE_GLYPH[block.type] ?? '•'}</span>
        <div style="min-width:0;flex:1">
          ${block.timeLabel ? `<div class="b-time">${esc(block.timeLabel)}</div>` : ''}
          <div class="b-title">${esc(block.title)}</div>
          ${block.meta ? `<div class="b-meta">${esc(block.meta)}</div>` : ''}
          ${block.notes ? `<div class="b-meta">${esc(block.notes)}</div>` : ''}
          ${block.map ? `<div class="b-meta">◉ ${esc(block.map.name)}</div>` : ''}
          ${
            block.link
              ? `<div class="b-meta"><a href="${esc(block.link.url)}" rel="nofollow noopener" target="_blank">${esc(block.link.title || block.link.host)} ↗</a></div>`
              : ''
          }
          ${block.photoCount > 0 ? `<div class="b-meta">▣ ${block.photoCount} photo${block.photoCount === 1 ? '' : 's'}</div>` : ''}
          ${block.isConfirmed ? '<div class="booked">✓ Booked</div>' : ''}
          ${blockComments
            .map((c) => `<div class="cmt"><b>${esc(c.authorName)}</b> ${esc(c.body)}</div>`)
            .join('')}
        </div>
      </article>`;
            })
            .join('')
    }
  </section>`,
  )
  .join('')}

  <div class="cta">
    <strong>Planning a trip of your own?</strong>
    <p class="b-meta" style="margin-top:6px">
      Build the itinerary, split the costs, bring the crew.
    </p>
    <a href="${esc(new URL('/', canonicalUrl).toString())}">Try Wandrly</a>
  </div>

  <footer>
    This is a read-only view. Costs, bookings, and expenses are private to the trip's crew.
  </footer>
</main>
</body>
</html>`;
}

/** Password prompt, shown when a link is protected (FR-SHARE-08). */
export function renderPasswordPage(slug: string, wrong: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Protected trip · Wandrly</title>
<meta name="robots" content="noindex,nofollow">
<style>
 body{background:#0A0B0E;color:#F2F3F5;font-family:system-ui,sans-serif;
      display:grid;place-items:center;min-height:100vh;margin:0}
 form{background:#12141A;border:1px solid #23262E;padding:28px;border-radius:14px;
      width:min(340px,90vw)}
 input{width:100%;padding:10px;margin:12px 0;border-radius:8px;border:1px solid #23262E;
       background:#191C23;color:inherit;font-size:15px}
 button{width:100%;padding:11px;border:0;border-radius:8px;background:#F0A05A;
        color:#fff;font-weight:600;font-size:15px;cursor:pointer}
 .err{color:#E25D4C;font-size:13px}
</style></head>
<body>
<form method="GET" action="/p/${esc(slug)}">
  <strong>This trip is password protected</strong>
  ${wrong ? '<p class="err">That password did not work.</p>' : ''}
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">View trip</button>
</form>
</body></html>`;
}
