#!/usr/bin/env node
// Builds heynomnom.in/restaurants/ (a list of live partner restaurants) and one page per restaurant with its full
// menu as plain HTML, so Google can index every dish. Also rewrites sitemap.xml.
// Data: the public menus in Supabase (the same ones guests see). Paused and archived menus aren't readable with the
// public key, so they drop out automatically.
// Run: node tools/build-restaurants.mjs   (a GitHub Action runs it every day and commits any changes)
import { writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://heynomnom.in';
const MENU = 'https://menu.heynomnom.in/';
const SUPABASE = process.env.SUPABASE_URL || 'https://fjdfzjslxxbqeavbbcvb.supabase.co';
// The public (anon) key: it can only read published menus.
const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqZGZ6anNseHhicWVhdmJiY3ZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5MDMyMTQsImV4cCI6MjExMDQ3OTIxNH0.NFMUV0gBewjmw2R0Z616nzdiFXIDq9_GgoWdOu1jcrQ';
// Internal and test menus never get a public page.
const SKIP = new Set(['demo', 'nomnom-test-cafe', 'zz-onboard-test', 'frootys']);
const MIN_DISHES = 5;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const today = new Date().toISOString().slice(0, 10);
const rupee = (n) => (Number(n) > 0 ? `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Number(n))}` : '');
const httpsOnly = (u) => (/^https:\/\//.test(String(u || '')) ? u : '');

async function fetchMenus() {
  const res = await fetch(`${SUPABASE}/rest/v1/menus?select=slug,data,updated_at&order=slug`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

function sectionsOf(d) {
  // Category sections in menu order; any dish whose category has no section goes under its own category name.
  const cats = (d.sections || []).filter((s) => s.type === 'category');
  const byMatch = new Map(cats.map((c) => [c.match, { label: clean(c.label).replace(/^(.+?) · \1$/i, '$1'), dishes: [] }]));
  const extra = new Map();
  for (const dish of d.dishes || []) {
    if (dish.available === false || !clean(dish.name)) continue;
    const sec = byMatch.get(dish.category) || extra.get(dish.category) || extra.set(dish.category, { label: clean(dish.category) || 'More', dishes: [] }).get(dish.category);
    sec.dishes.push(dish);
  }
  return [...byMatch.values(), ...extra.values()].filter((s) => s.dishes.length);
}

const vegMark = (dish) => {
  const veg = dish.diet?.veg !== false;
  return `<span class="mark ${veg ? 'veg' : 'nonveg'}" role="img" aria-label="${veg ? 'Vegetarian' : 'Non-vegetarian'}"></span>`;
};

const head = ({ title, description, url, image, jsonld }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="theme-color" content="#0b0b0c">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="NomNom">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(image || `${SITE}/assets/intro-poster.jpg`)}">
  <meta property="og:locale" content="en_IN">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
  <link rel="apple-touch-icon" href="/assets/nomnom-512.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500..800&family=Inter:wght@400..600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/restaurants.css">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="bar"><div class="wrap">
    <a class="logo" href="/" aria-label="NomNom home"></a>
    <nav aria-label="Main"><a href="/restaurants/">Restaurants</a><a href="/video-menu/">What is a video menu?</a></nav>
    <a class="btn btn-dark" href="/#pilot">Book a demo</a>
  </div></header>`;

const foot = `
  <footer><div class="wrap">
    <a class="logo" href="/" aria-label="NomNom home"></a>
    <nav aria-label="Footer"><a href="/">Home</a><a href="/restaurants/">Partner restaurants</a><a href="/video-menu/">What is a video menu?</a><a href="/#pilot">Pilot</a></nav>
    <span>© ${new Date().getFullYear()} NomNom · Make them see it. Make them crave it.</span>
  </div></footer>
</body>
</html>
`;

function restaurantPage(r) {
  const d = r.data;
  const name = clean(d.name);
  const url = `${SITE}/restaurants/${r.slug}/`;
  const menuLink = `${MENU}?r=${encodeURIComponent(r.slug)}`;
  const secs = sectionsOf(d);
  const dishes = secs.flatMap((s) => s.dishes);
  const videos = dishes.filter((x) => httpsOnly(x.video));
  const loved = (videos.length ? videos : dishes.filter((x) => httpsOnly(x.image))).slice(0, 8);
  const priced = dishes.filter((x) => Number(x.price) > 0).map((x) => Number(x.price));
  const cover = httpsOnly(loved[0]?.thumb || loved[0]?.image) || httpsOnly(d.logo);
  const tagline = clean(d.tagline);
  const insta = httpsOnly(d.links?.instagram);
  const maps = httpsOnly(d.links?.google);
  const top = dishes.slice(0, 4).map((x) => clean(x.name)).join(', ');
  const description = `${name} menu with prices: ${dishes.length} items${secs.length ? ` across ${secs.slice(0, 3).map((s) => s.label).join(', ')}` : ''}. ${top ? `Popular: ${top}.` : ''} See every dish on ${name}'s NomNom video menu.`.slice(0, 300);
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Restaurant',
        '@id': `${url}#restaurant`,
        name,
        url,
        ...(tagline ? { description: tagline } : {}),
        ...(httpsOnly(d.logo) ? { logo: d.logo, image: cover || d.logo } : cover ? { image: cover } : {}),
        servesCuisine: [...new Set((d.sections || []).filter((s) => s.type === 'category').slice(0, 6).map((s) => clean(s.label).split(' · ')[0]))],
        ...(priced.length ? { priceRange: `${rupee(Math.min(...priced))}–${rupee(Math.max(...priced))}` } : {}),
        ...(insta || maps ? { sameAs: [insta, maps].filter(Boolean) } : {}),
        hasMenu: { '@id': `${url}#menu` },
      },
      {
        '@type': 'Menu',
        '@id': `${url}#menu`,
        name: `${name} menu`,
        url: menuLink,
        inLanguage: 'en-IN',
        hasMenuSection: secs.map((s) => ({
          '@type': 'MenuSection',
          name: s.label,
          hasMenuItem: s.dishes.map((x) => ({
            '@type': 'MenuItem',
            name: clean(x.name),
            ...(clean(x.description) ? { description: clean(x.description).slice(0, 300) } : {}),
            ...(httpsOnly(x.image) ? { image: x.image } : {}),
            ...(Number(x.price) > 0 ? { offers: { '@type': 'Offer', price: String(x.price), priceCurrency: d.currency || 'INR' } } : {}),
            suitableForDiet: x.diet?.veg !== false ? 'https://schema.org/VegetarianDiet' : undefined,
          })),
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'NomNom', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Restaurants', item: `${SITE}/restaurants/` },
          { '@type': 'ListItem', position: 3, name, item: url },
        ],
      },
    ],
  };
  const dishRow = (x) => {
    const img = httpsOnly(x.thumb || x.image);
    return `
          <li class="dish">
            ${img ? `<img src="${esc(img)}" alt="${esc(clean(x.name))}" loading="lazy" decoding="async" width="72" height="72">` : '<span class="ph" aria-hidden="true"></span>'}
            <div class="dish-main">
              <h4>${vegMark(x)}${esc(clean(x.name))}${httpsOnly(x.video) ? ' <span class="has-video" title="Has a video on the menu">▶ video</span>' : ''}</h4>
              ${clean(x.description) ? `<p>${esc(clean(x.description))}</p>` : ''}
            </div>
            <span class="price">${esc(rupee(x.price))}</span>
          </li>`;
  };
  return `${head({ title: `${name} Menu & Prices · NomNom`, description, url, image: cover, jsonld })}
  <main id="main"><div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">NomNom</a> / <a href="/restaurants/">Restaurants</a> / ${esc(name)}</nav>
    <section class="r-hero">
      ${httpsOnly(d.logo) ? `<img class="r-logo" src="${esc(d.logo)}" alt="${esc(name)} logo" width="88" height="88">` : `<span class="r-logo mono" aria-hidden="true">${esc(name[0] || '?')}</span>`}
      <div>
        <p class="eyebrow">Partner restaurant</p>
        <h1>${esc(name)} menu</h1>
        ${tagline ? `<p class="lede">${esc(tagline)}</p>` : ''}
        <p class="meta">${dishes.length} items · ${secs.length} sections${videos.length ? ` · ${videos.length} dish videos` : ''}${priced.length ? ` · ${esc(rupee(Math.min(...priced)))}–${esc(rupee(Math.max(...priced)))}` : ''}</p>
        <div class="ctas">
          <a class="btn btn-heat" href="${esc(menuLink)}" target="_blank" rel="noopener">Open the video menu</a>
          ${insta ? `<a class="btn btn-dark" href="${esc(insta)}" target="_blank" rel="noopener">Instagram</a>` : ''}
          ${maps ? `<a class="btn btn-ghost" href="${esc(maps)}" target="_blank" rel="noopener">Google Maps</a>` : ''}
        </div>
      </div>
    </section>
    ${loved.length ? `
    <section class="loved" aria-labelledby="loved-title">
      <h2 id="loved-title">${videos.length ? 'See them in motion' : 'Highlights'}</h2>
      <div class="rail">${loved.map((x) => `
        <a class="tile" href="${esc(menuLink)}" target="_blank" rel="noopener">
          ${httpsOnly(x.thumb || x.image) ? `<img src="${esc(x.thumb || x.image)}" alt="${esc(clean(x.name))}" loading="lazy" decoding="async">` : '<span class="ph"></span>'}
          ${httpsOnly(x.video) ? '<span class="play" aria-hidden="true">▶</span>' : ''}
          <span class="cap"><b>${esc(clean(x.name))}</b>${Number(x.price) > 0 ? `<small>${esc(rupee(x.price))}</small>` : ''}</span>
        </a>`).join('')}
      </div>
    </section>` : ''}
    <nav class="toc" aria-label="Menu sections">${secs.map((s, i) => `<a href="#s${i}">${esc(s.label)}</a>`).join('')}</nav>
    <div class="menu">${secs.map((s, i) => `
      <section class="sec" id="s${i}" aria-labelledby="h${i}">
        <h3 id="h${i}">${esc(s.label)} <small>${s.dishes.length}</small></h3>
        <ul>${s.dishes.map(dishRow).join('')}
        </ul>
      </section>`).join('')}
    </div>
    ${clean(d.footerNote) ? `<p class="note">${esc(clean(d.footerNote))}</p>` : ''}
    <section class="cta">
      <h2>Order the way ${esc(name)}’s guests do</h2>
      <p>Scan the QR at ${esc(name)} or open the live menu to see every dish as a short video, filter veg and non-veg, and order.</p>
      <div class="ctas"><a class="btn btn-heat" href="${esc(menuLink)}" target="_blank" rel="noopener">Open ${esc(name)}’s video menu</a><a class="btn btn-dark" href="/#pilot">Get NomNom for your restaurant</a></div>
    </section>
  </div></main>${foot}`;
}

function listPage(list) {
  const url = `${SITE}/restaurants/`;
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Restaurants and cafés on NomNom',
    url,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: list.map((r, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/restaurants/${r.slug}/`, name: clean(r.data.name) })),
    },
  };
  return `${head({ title: 'Partner restaurants & cafés · NomNom video menus', description: `Explore the menus of ${list.length} restaurants, cafés and bakeries that use NomNom video menus: every dish, price and photo, with short videos on the live menu.`, url, jsonld })}
  <main id="main"><div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">NomNom</a> / Restaurants</nav>
    <section class="list-hero">
      <p class="eyebrow">Partner restaurants</p>
      <h1>Menus that make you <span class="heat">hungry.</span></h1>
      <p class="lede">${list.length} restaurants, cafés and bakeries show their dishes on NomNom. Explore their menus, then open the live video menu.</p>
    </section>
    <div class="grid">${list.map((r) => {
      const d = r.data;
      const secs = sectionsOf(d);
      const dishes = secs.flatMap((s) => s.dishes);
      const pic = dishes.find((x) => httpsOnly(x.video) && httpsOnly(x.thumb || x.image)) || dishes.find((x) => httpsOnly(x.thumb || x.image));
      const vids = dishes.filter((x) => httpsOnly(x.video)).length;
      return `
      <a class="card" href="/restaurants/${esc(r.slug)}/">
        <span class="card-img">${pic ? `<img src="${esc(pic.thumb || pic.image)}" alt="${esc(clean(pic.name))} at ${esc(clean(d.name))}" loading="lazy" decoding="async">` : ''}${vids ? `<span class="badge">▶ ${vids} videos</span>` : ''}</span>
        <span class="card-body">
          ${httpsOnly(d.logo) ? `<img class="card-logo" src="${esc(d.logo)}" alt="" loading="lazy" width="44" height="44">` : `<span class="card-logo mono">${esc(clean(d.name)[0] || '?')}</span>`}
          <span><b>${esc(clean(d.name))}</b><small>${esc(clean(d.tagline) || secs.slice(0, 3).map((s) => s.label).join(' · '))}</small><small class="count">${dishes.length} items</small></span>
        </span>
      </a>`;
    }).join('')}
    </div>
    <section class="cta">
      <h2>Want your restaurant here?</h2>
      <p>NomNom turns your menu into a video menu guests open from the table QR. We set it up for you in a 30-day pilot.</p>
      <div class="ctas"><a class="btn btn-heat" href="/#pilot">Start a pilot</a><a class="btn btn-dark" href="/video-menu/">What is a video menu?</a></div>
    </section>
  </div></main>${foot}`;
}

function sitemap(list) {
  const urls = [
    [`${SITE}/`, '2026-11-28'], [`${SITE}/video-menu/`, '2026-11-27'],
    [`${SITE}/restaurants/`, list.map((r) => String(r.updated_at || '').slice(0, 10)).sort().pop() || today],
    ...list.map((r) => [`${SITE}/restaurants/${r.slug}/`, String(r.updated_at || today).slice(0, 10)]),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Built by tools/build-restaurants.mjs. Add other new pages (guides, blog posts) to the list in that script. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([loc, mod]) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${mod}</lastmod>\n  </url>`).join('\n')}
</urlset>
`;
}

const rows = await fetchMenus();
const list = rows
  .filter((r) => !SKIP.has(r.slug) && clean(r.data?.name) && sectionsOf(r.data).flatMap((s) => s.dishes).length >= MIN_DISHES)
  .sort((a, b) => {
    const v = (r) => (r.data.dishes || []).filter((x) => httpsOnly(x.video)).length;
    return v(b) - v(a) || clean(a.data.name).localeCompare(clean(b.data.name));
  });

const out = join(ROOT, 'restaurants');
// Remove pages of restaurants that are no longer live (paused, archived or deleted).
if (existsSync(out)) for (const dir of readdirSync(out, { withFileTypes: true })) {
  if (dir.isDirectory() && !list.some((r) => r.slug === dir.name)) rmSync(join(out, dir.name), { recursive: true });
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), listPage(list));
for (const r of list) {
  mkdirSync(join(out, r.slug), { recursive: true });
  writeFileSync(join(out, r.slug, 'index.html'), restaurantPage(r));
}
writeFileSync(join(ROOT, 'sitemap.xml'), sitemap(list));
console.log(`Built ${list.length} restaurant pages: ${list.map((r) => r.slug).join(', ')}`);
