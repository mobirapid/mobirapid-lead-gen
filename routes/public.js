// Public site routes: homepage, robots/sitemap, blog, /api/site, compare,
// product/category/condition pages and content pages.
// All code moved verbatim from server.js.
const express = require('express');
const db = require('../db');
const {
  PRIVATE_KEYS, getSetting, getAllSettings, parseJsonSetting,
  googleLiveEnabled, getGCache, G_TTL, refreshGoogleRating,
} = require('../lib/settings');
const { esc, ver, baseUrl } = require('../lib/util');
const {
  renderIndex, pageHead, pageTail, siteHeaderHtml, businessDetailsHtml,
} = require('../lib/render');
const {
  catByPrefix, catBySlug, productUrl, reserveButton, isSoldOut,
  discountHtml, availabilityButton, gradeBadgeClass,
} = require('../lib/catalog');

const router = express.Router();

// ===========================================================================
// PUBLIC PAGES (SEO meta + analytics injected server-side)
// ===========================================================================

router.get('/', (req, res) => res.type('html').send(renderIndex(req)));

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /manage\nDisallow: /api/\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});
router.get('/sitemap.xml', (req, res) => {
  const base = baseUrl(req);
  const today = new Date().toISOString().slice(0, 10);
  const pages = db.prepare('SELECT slug FROM content_pages ORDER BY sort_order').all();
  const posts = db.prepare('SELECT slug, updated_at, created_at FROM blog_posts WHERE published = 1 ORDER BY id DESC').all();
  const cats = db.prepare('SELECT slug, url_prefix FROM categories WHERE active = 1').all();
  const prefixOf = {}; for (const c of cats) prefixOf[c.slug] = c.url_prefix;
  const prods = db.prepare(`SELECT m.slug, m.category FROM macbook_models m
    LEFT JOIN categories c ON c.slug = m.category
    WHERE m.active = 1 AND m.slug IS NOT NULL AND (c.active = 1 OR c.slug IS NULL) ORDER BY m.sort_order`).all();
  const entries = [
    { loc: '/', lastmod: today, priority: '1.0' },
    { loc: '/compare', lastmod: today, priority: '0.7' },
    { loc: '/condition', lastmod: today, priority: '0.5' },
    { loc: '/blog', lastmod: today, priority: '0.8' },
    ...cats.map((c) => ({ loc: '/c/' + c.slug, lastmod: today, priority: '0.8' })),
    ...prods.map((p) => ({ loc: '/' + (prefixOf[p.category] || 'macbook') + '/' + p.slug, lastmod: today, priority: '0.7' })),
    ...pages.map((p) => ({ loc: '/p/' + p.slug, lastmod: today, priority: '0.4' })),
    ...posts.map((p) => ({ loc: '/blog/' + p.slug, lastmod: String(p.updated_at || p.created_at || today).slice(0, 10), priority: '0.6' })),
  ];
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries.map((e) => `  <url><loc>${base}${e.loc}</loc><lastmod>${e.lastmod}</lastmod><priority>${e.priority}</priority></url>`).join('\n') +
    `\n</urlset>`;
  res.type('application/xml').send(xml);
});

function fmtBlogDate(s) {
  try { return new Date(String(s).replace(' ', 'T') + 'Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; }
}

function postTags(p) { return String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean); }
function blogCardHtml(p, brand) {
  return `
    <a class="blog-card" href="/blog/${esc(p.slug)}">
      <div class="blog-cover" style="${p.cover_image ? `background-image:url('${esc(p.cover_image)}')` : ''}">${p.cover_image ? '' : '<span></span>'}</div>
      <div class="blog-card-body">
        <h3>${esc(p.title)}</h3>
        <p class="blog-excerpt">${esc(p.excerpt || '')}</p>
        <span class="blog-meta">${esc(p.author || brand)} · ${fmtBlogDate(p.created_at)}</span>
      </div>
    </a>`;
}

router.get('/blog', (req, res) => {
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const q = String(req.query.q || '').trim().toLowerCase();
  const tag = String(req.query.tag || '').trim().toLowerCase();
  let posts = db.prepare('SELECT slug, title, excerpt, cover_image, author, created_at, tags FROM blog_posts WHERE published = 1 ORDER BY id DESC').all();
  if (tag) posts = posts.filter((p) => postTags(p).map((t) => t.toLowerCase()).includes(tag));
  if (q) posts = posts.filter((p) => `${p.title} ${p.excerpt || ''} ${p.tags || ''}`.toLowerCase().includes(q));

  // Tag cloud from all published posts
  const allTags = {};
  for (const p of db.prepare('SELECT tags FROM blog_posts WHERE published = 1').all()) for (const t of postTags(p)) allTags[t] = (allTags[t] || 0) + 1;
  const tagChips = Object.keys(allTags).sort().map((t) =>
    `<a class="blog-tag${t.toLowerCase() === tag ? ' active' : ''}" href="/blog?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('');

  const PER_PAGE = 9;
  const totalPages = Math.max(1, Math.ceil(posts.length / PER_PAGE));
  let page = parseInt(req.query.page, 10) || 1;
  if (page < 1) page = 1; if (page > totalPages) page = totalPages;
  const pagePosts = posts.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const qs = (pg) => { const p = new URLSearchParams(); if (req.query.q) p.set('q', req.query.q); if (req.query.tag) p.set('tag', req.query.tag); if (pg > 1) p.set('page', pg); const s = p.toString(); return '/blog' + (s ? '?' + s : ''); };
  const pager = totalPages > 1
    ? `<div class="blog-pager">${page > 1 ? `<a href="${qs(page - 1)}">← Newer</a>` : '<span></span>'}<span class="blog-pager-info">Page ${page} of ${totalPages}</span>${page < totalPages ? `<a href="${qs(page + 1)}">Older →</a>` : '<span></span>'}</div>` : '';
  const cards = pagePosts.map((p) => blogCardHtml(p, brand)).join('');
  const heading = tag ? `Articles tagged "${esc(req.query.tag)}"` : q ? `Search: "${esc(req.query.q)}"` : esc(getSetting('blog_title', 'Blog'));
  const title = getSetting('blog_title', 'Blog') + ' — ' + brand;
  const desc = getSetting('blog_subtitle', '') || `${brand} blog — MacBook guides and Apple ecosystem tips.`;
  res.send(
    pageHead(req, title, desc, base + '/blog') +
    siteHeaderHtml() +
    `<main class="container page-body blog-index">
      <a class="back-link" href="/">← Back to home</a>
      <h1>${heading}</h1>
      <form class="blog-search" method="get" action="/blog"><input type="search" name="q" value="${esc(req.query.q || '')}" placeholder="Search articles…"><button type="submit">Search</button></form>
      ${tagChips ? `<div class="blog-tags-bar">${(tag || q) ? '<a class="blog-tag" href="/blog">All</a>' : ''}${tagChips}</div>` : ''}
      <div class="blog-grid">${cards || '<p class="muted">No articles found.</p>'}</div>
      ${pager}
    </main>` +
    pageTail()
  );
});

router.get('/blog/:slug', (req, res) => {
  const post = db.prepare('SELECT * FROM blog_posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!post) return res.status(404).send('Post not found');
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const url = base + '/blog/' + esc(post.slug);
  const desc = post.meta_description || post.excerpt || post.title;
  const ld = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title,
    description: post.excerpt || post.meta_description || post.title,
    datePublished: post.created_at, dateModified: post.updated_at || post.created_at,
    author: { '@type': 'Organization', name: post.author || brand },
    publisher: { '@type': 'Organization', name: getSetting('legal_name', '') || brand },
    mainEntityOfPage: url,
  };
  if (post.cover_image) ld.image = post.cover_image.startsWith('/') ? base + post.cover_image : post.cover_image;
  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;

  const tags = postTags(post);
  const tagsHtml = tags.length
    ? `<div class="blog-tags-bar">${tags.map((t) => `<a class="blog-tag" href="/blog?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : '';

  // Related: prefer posts sharing a tag, then fill with latest.
  const others = db.prepare('SELECT slug, title, excerpt, cover_image, author, created_at, tags FROM blog_posts WHERE published = 1 AND id != ? ORDER BY id DESC').all(post.id);
  const lower = tags.map((t) => t.toLowerCase());
  let related = others.filter((o) => postTags(o).some((t) => lower.includes(t.toLowerCase())));
  for (const o of others) { if (related.length >= 3) break; if (!related.includes(o)) related.push(o); }
  related = related.slice(0, 3);
  const relatedHtml = related.length
    ? `<section class="blog-related"><h2>Related articles</h2><div class="blog-grid">${related.map((p) => blogCardHtml(p, brand)).join('')}</div></section>` : '';

  res.send(
    pageHead(req, post.title + ' — ' + brand, desc, url, ldTag) +
    siteHeaderHtml() +
    `<main class="container page-body blog-post"><a class="back-link" href="/blog">← All articles</a>
    <h1>${esc(post.title)}</h1>
    <p class="blog-meta">${esc(post.author || brand)} · ${fmtBlogDate(post.created_at)}</p>
    ${post.cover_image ? `<img class="blog-hero-img" src="${esc(post.cover_image)}" alt="${esc(post.title)}">` : ''}
    <div class="page-content blog-content">${post.content || ''}</div>
    ${tagsHtml}
    <div class="blog-cta"><a class="hero-button" href="/#lead-form">Book a free consultation →</a></div>
    ${relatedHtml}
    </main>` +
    pageTail()
  );
});

// ===========================================================================
// PUBLIC API
// ===========================================================================

// Site content for the landing page
router.get('/api/site', (req, res) => {
  const all = getAllSettings();
  const s = {};
  for (const k of Object.keys(all)) if (!PRIVATE_KEYS.has(k)) s[k] = all[k]; // never expose secrets
  // Only products in active categories (a hidden category hides all its products site-wide).
  const models = db
    .prepare(`SELECT m.* FROM macbook_models m
              LEFT JOIN categories c ON c.slug = m.category
              WHERE m.active = 1 AND (c.active = 1 OR c.slug IS NULL)
              ORDER BY m.sort_order ASC, m.id ASC`)
    .all();
  const pages = db
    .prepare('SELECT slug, title FROM content_pages ORDER BY sort_order ASC, title ASC')
    .all();
  const posts = getSetting('blog_enabled', '1') === '1'
    ? db.prepare('SELECT slug, title, excerpt, cover_image, author, created_at FROM blog_posts WHERE published = 1 ORDER BY id DESC LIMIT 3').all()
    : [];
  const reviewsEnabled = getSetting('reviews_enabled', '0') === '1';
  let reviews = reviewsEnabled
    ? db.prepare('SELECT id, author, rating, text, date_label FROM reviews WHERE active = 1 ORDER BY sort_order ASC, id ASC').all()
    : [];
  // Live Google rating (overrides the manual rating/count, and reviews if available)
  if (googleLiveEnabled()) {
    const gCache = getGCache();
    if (Date.now() - gCache.at > G_TTL) refreshGoogleRating(); // async refresh; serve cached meanwhile
    if (gCache.rating != null) { s.google_rating = String(gCache.rating); s.google_review_count = String(gCache.count || 0); }
    if (reviewsEnabled && gCache.reviews && gCache.reviews.length) reviews = gCache.reviews;
  }
  res.json({
    ok: true,
    settings: {
      ...s,
      reviews_enabled: reviewsEnabled,
      about_enabled: getSetting('about_enabled', '1') === '1',
      contact_enabled: getSetting('contact_enabled', '1') === '1',
      blog_enabled: getSetting('blog_enabled', '1') === '1',
      qc_enabled: getSetting('qc_enabled', '1') === '1',
      qc_video_enabled: getSetting('qc_video_enabled', '1') === '1',
      qc_items: parseJsonSetting('qc_items', []),
      faq_enabled: getSetting('faq_enabled', '1') === '1',
      faq_items: parseJsonSetting('faq_items', []),
      usps_enabled: getSetting('usps_enabled', '1') === '1',
      usps: parseJsonSetting('usps', []),
      trust_points: parseJsonSetting('trust_points', []),
      requirement_options: parseJsonSetting('requirement_options', []),
      budget_options: parseJsonSetting('budget_options', []),
    },
    models,
    categories: db.prepare('SELECT slug, name, singular, url_prefix, tagline, fields, price_note, sort_order, CASE WHEN show_home = 0 THEN 0 ELSE 1 END AS show_home FROM categories WHERE active = 1 ORDER BY sort_order ASC, id ASC').all(),
    pages,
    reviews,
    posts,
  });
});

// security.txt (RFC 9116) — how to report a security issue. Expires auto-renews.
router.get(['/.well-known/security.txt', '/security.txt'], (req, res) => {
  const email = getSetting('customer_care_email', '') || getSetting('footer_email', '') || 'security@mobirapid.com';
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const host = req.headers.host || 'mobirapid.in';
  res.type('text/plain').send(
    `Contact: mailto:${email}\n` +
    `Expires: ${expires}\n` +
    `Preferred-Languages: en\n` +
    `Canonical: https://${host}/.well-known/security.txt\n`
  );
});

// Compare page (server-rendered fallback + interactive picker)
router.get('/compare', (req, res) => {
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const priceNote = getSetting('price_note', '');
  const models = db.prepare('SELECT * FROM macbook_models WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
  const ROWS = [
    ['price', 'Price'], ['cpu', 'Chip / CPU'], ['gpu', 'GPU'], ['memory', 'Memory'],
    ['storage', 'Storage'], ['display', 'Display'], ['condition_grade', 'Condition'], ['warranty', 'Warranty'],
  ];
  // Server-rendered fallback: full spec table for all models (SEO + no-JS)
  const fallbackCols = models.map((m) =>
    `<th scope="col"><a href="/macbook/${esc(m.slug)}">${esc(m.name)}</a></th>`).join('');
  const fallbackRows = ROWS.map(([k, label]) =>
    `<tr><th scope="row">${esc(label)}</th>${models.map((m) => `<td>${esc(m[k] || '—')}</td>`).join('')}</tr>`).join('');
  const fallback = `<div class="cmp-scroll"><table class="cmp-table"><thead><tr><th></th>${fallbackCols}</tr></thead>
    <tbody>${fallbackRows}</tbody></table></div>`;

  const data = models.map((m) => ({
    slug: m.slug, name: m.name, image: m.image || '', price: m.price || '', mrp: m.mrp || '', badge: m.badge || '',
    cpu: m.cpu || '', gpu: m.gpu || '', memory: m.memory || '', storage: m.storage || '',
    display: m.display || '', condition_grade: m.condition_grade || '', warranty: m.warranty || '',
  }));
  const jsonData = JSON.stringify(data).replace(/</g, '\\u003c');
  const jsonRows = JSON.stringify(ROWS);
  const preIds = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);

  const ld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: 'Compare refurbished MacBooks',
    itemListElement: models.map((m, i) => ({ '@type': 'ListItem', position: i + 1, url: base + '/macbook/' + esc(m.slug), name: m.name })),
  };
  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;

  res.send(
    pageHead(req, 'Compare Refurbished MacBooks — ' + brand,
      'Compare refurbished MacBook models side by side — chip, CPU & GPU cores, memory, storage, display and price. Pick the right Mac for your work.',
      base + '/compare', ldTag) +
    siteHeaderHtml() +
    `<main class="container page-body cmp">
      <a class="back-link" href="/#modelsSection">← All MacBooks</a>
      <h1>Compare refurbished MacBooks</h1>
      <p class="cmp-intro">Select up to four models to compare specs side by side.${priceNote ? ' ' + esc(priceNote) + '.' : ''}</p>
      <div class="cmp-picker" id="cmpPicker">${models.map((m) =>
        `<label class="cmp-chip"><input type="checkbox" value="${esc(m.slug)}"> ${esc(m.name)}</label>`).join('')}</div>
      <div id="cmpApp" hidden></div>
      <noscript>${fallback}</noscript>
      <div id="cmpFallback">${fallback}</div>
    </main>
    <script>
    (function(){
      var DATA = ${jsonData}, ROWS = ${jsonRows}, PRE = ${JSON.stringify(preIds)};
      var picker = document.getElementById('cmpPicker');
      var app = document.getElementById('cmpApp');
      var fallback = document.getElementById('cmpFallback');
      var boxes = Array.prototype.slice.call(picker.querySelectorAll('input'));
      function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
      function selected(){return boxes.filter(function(b){return b.checked;}).map(function(b){return b.value;});}
      function bySlug(s){for(var i=0;i<DATA.length;i++){if(DATA[i].slug===s)return DATA[i];}return null;}
      function build(){
        var sel = selected();
        if(!sel.length){app.innerHTML='<p class="cmp-empty">Pick at least two models above to compare.</p>';return;}
        var models = sel.map(bySlug).filter(Boolean);
        var head='<tr><th></th>'+models.map(function(m){
          return '<th scope="col"><div class="cmp-card">'+
            (m.image?'<img src="'+esc(m.image)+'" alt="'+esc(m.name)+'">':'<div class="cmp-ph"></div>')+
            (m.badge?'<span class="cmp-badge">'+esc(m.badge)+'</span>':'')+
            '<a href="/macbook/'+esc(m.slug)+'">'+esc(m.name)+'</a></div></th>';
        }).join('')+'</tr>';
        var body=ROWS.map(function(r){
          return '<tr><th scope="row">'+esc(r[1])+'</th>'+models.map(function(m){
            return '<td'+(r[0]==='price'?' class="cmp-price"':'')+'>'+esc(m[r[0]]||'—')+'</td>';
          }).join('')+'</tr>';
        }).join('');
        var cta='<tr><th scope="row"></th>'+models.map(function(m){
          return '<td><a class="cmp-book" href="/?model='+encodeURIComponent(m.slug)+'#lead-form">Book Now →</a></td>';
        }).join('')+'</tr>';
        app.innerHTML='<div class="cmp-scroll"><table class="cmp-table cmp-live"><thead>'+head+'</thead><tbody>'+body+cta+'</tbody></table></div>';
      }
      function limit(){
        var sel=selected();
        boxes.forEach(function(b){var over=sel.length>=4&&!b.checked;b.disabled=over;b.parentNode.classList.toggle('disabled',over);});
      }
      function syncUrl(){
        var sel=selected();var u=new URL(location.href);
        if(sel.length)u.searchParams.set('ids',sel.join(','));else u.searchParams.delete('ids');
        history.replaceState(null,'',u);
      }
      boxes.forEach(function(b){b.addEventListener('change',function(){limit();build();syncUrl();});});
      // initial selection: from ?ids or first three
      var init = PRE.filter(function(s){return bySlug(s);});
      if(!init.length) init = DATA.slice(0,3).map(function(m){return m.slug;});
      boxes.forEach(function(b){b.checked = init.indexOf(b.value)>-1;});
      fallback.hidden=true; app.hidden=false; limit(); build();
    })();
    </script>` +
    pageTail()
  );
});

// Product detail page (server-rendered, Product schema) — category-aware.
// Generic route: /:prefix/:slug where :prefix matches a category url_prefix (else next()).
router.get('/:prefix/:slug', (req, res, next) => {
  const cat = catByPrefix(req.params.prefix);
  if (!cat) return next(); // not a product prefix — let /p/:slug, /blog/:slug, etc. handle it
  const m = db.prepare('SELECT * FROM macbook_models WHERE slug = ? AND category = ? AND active = 1').get(req.params.slug, cat.slug);
  if (!m) return res.status(404).send('Product not found');
  renderProductPage(req, res, m, cat);
});

function renderProductPage(req, res, m, cat) {
  const isPhone = cat.fields === 'phone';
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const priceNote = (cat.price_note || '').trim() || getSetting('price_note', '');
  const bookUrl = `/?model=${encodeURIComponent(m.slug)}#lead-form`;
  const priceNum = String(m.price || '').replace(/[^\d.]/g, '');
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: m.name,
    description: m.description || m.specs || m.name,
    category: isPhone ? 'Refurbished Mobile Phone' : 'Refurbished Laptop',
    itemCondition: 'https://schema.org/RefurbishedCondition',
  };
  if (!isPhone) ld.brand = { '@type': 'Brand', name: 'Apple' };
  if (m.image) ld.image = m.image.startsWith('/') ? base + m.image : m.image;
  const specRows = isPhone
    ? [['Processor', m.cpu], ['Storage', m.storage], ['Battery health', m.battery_health], ['Colour', m.colour], ['Condition', m.condition_grade ? m.condition_grade + ' (refurbished)' : ''], ['Warranty', m.warranty]]
    : [['Chip / CPU', m.cpu], ['GPU', m.gpu], ['Memory (RAM)', m.memory], ['Storage', m.storage], ['Display', m.display], ['Condition', m.condition_grade ? m.condition_grade + ' (refurbished)' : ''], ['Warranty', m.warranty]];
  const rows = specRows.filter((r) => r[1]);
  const props = rows.filter((r) => !/Condition|Warranty/.test(r[0]));
  if (props.length) ld.additionalProperty = props.map((p) => ({ '@type': 'PropertyValue', name: p[0], value: p[1] }));
  const soldOut = isSoldOut(m);
  if (priceNum) ld.offers = { '@type': 'Offer', price: priceNum, priceCurrency: 'INR', availability: soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock', url: base + productUrl(m, cat) };
  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  const desc = (m.description || m.specs || m.name).slice(0, 180);
  const badge = m.badge ? `<span class="pdp-badge ${soldOut ? 'soldout' : /hot/i.test(m.badge) ? 'hot' : 'avail'}">${esc(m.badge)}</span>` : '';
  const metaBits = isPhone
    ? [m.condition_grade ? `<a class="pdp-tag cond-pill ${gradeBadgeClass(m.condition_grade)}" href="/condition" title="What does this grade mean?">${esc(m.condition_grade)} ⓘ</a>` : '', m.battery_health ? `<span class="pdp-tag">Battery ${esc(m.battery_health)}</span>` : '', m.warranty ? `<span class="pdp-tag">${esc(m.warranty)}</span>` : '']
    : [m.condition_grade ? `<a class="pdp-tag cond-pill ${gradeBadgeClass(m.condition_grade)}" href="/condition" title="What does this grade mean?">${esc(m.condition_grade)} ⓘ</a>` : '', m.warranty ? `<span class="pdp-tag">${esc(m.warranty)}</span>` : ''];
  res.send(
    pageHead(req, m.name + ' — ' + brand, desc, base + productUrl(m, cat), ldTag) +
    siteHeaderHtml() +
    `<main class="container page-body pdp">
      <a class="back-link" href="/c/${esc(cat.slug)}">← All ${esc(cat.name)}</a>
      <div class="pdp-grid">
        ${(() => {
          let gallery = [];
          try { gallery = JSON.parse(m.images || '[]'); } catch { gallery = []; }
          if (!gallery.length && m.image) gallery = [m.image];
          gallery = gallery.filter(Boolean);
          if (!gallery.length) return `<div class="pdp-media"><div class="pdp-media-ph"><span></span></div>${badge}</div>`;
          const main = `<div class="pdp-media" id="pdpMain">${badge}<img id="pdpMainImg" src="${esc(gallery[0])}" alt="${esc(m.name)}"></div>`;
          const thumbs = gallery.length > 1
            ? `<div class="pdp-thumbs" id="pdpThumbs">${gallery.map((g, i) => `<button type="button" class="pdp-thumb${i === 0 ? ' on' : ''}" data-img="${esc(g)}"><img src="${esc(g)}" alt="${esc(m.name)} photo ${i + 1}" loading="lazy"></button>`).join('')}</div>`
            : '';
          return `<div class="pdp-gallery">${main}${thumbs}</div>`;
        })()}
        <div class="pdp-info">
          <h1>${esc(m.name)}</h1>
          ${m.specs ? `<p class="pdp-specs">${esc(m.specs)}</p>` : ''}
          ${m.price ? `<div class="pdp-price">${esc(m.price)}${discountHtml(m)} ${priceNote ? `<span class="pdp-gst">${esc(priceNote)}</span>` : ''}</div>` : '<div class="pdp-price-req">Price on request</div>'}
          <div class="pdp-meta">${metaBits.filter(Boolean).join('')}</div>
          ${m.description ? `<p class="pdp-desc">${esc(m.description)}</p>` : ''}
          ${soldOut ? '<p class="pdp-oos-note">This product is currently <strong>out of stock</strong>. Leave your details and we\'ll tell you when it\'s available again.</p>' : ''}
          <div class="pdp-actions">
            ${soldOut
              ? `${availabilityButton(m, 'pdp-book pdp-avail')}
            ${!isPhone ? `<a class="pdp-compare" href="/compare?ids=${encodeURIComponent(m.slug)}">Compare with other models</a>` : ''}`
              : `<a class="pdp-book" href="${bookUrl}">Book Now →</a>
            ${reserveButton(m.slug, 'pdp-reserve')}
            ${!isPhone ? `<a class="pdp-compare" href="/compare?ids=${encodeURIComponent(m.slug)}">Compare with other models</a>` : ''}`}
          </div>
          <ul class="pdp-trust">
            <li>✓ 35-point quality check</li>
            <li>✓ GST invoice with serial number</li>
            <li>✓ Free video-call verification before you pay</li>
          </ul>
        </div>
      </div>
      ${(() => {
        const openBox = /new|sealed|open box/i.test(m.condition_grade || '');
        const wMain = openBox ? 'Brand warranty' : '6 months warranty';
        const wSub = openBox ? 'Manufacturer warranty' : 'Mobirapid warranty';
        return `<div class="pdp-trustbar">
          <a class="pdp-tb" href="/p/refund-policy">
            <span class="pdp-tb-ic">↩</span><span class="pdp-tb-tx"><b>Easy returns</b><small>Read return policy</small></span>
          </a>
          <div class="pdp-tb">
            <span class="pdp-tb-ic">🛡</span><span class="pdp-tb-tx"><b>${wMain}</b><small>${wSub}</small></span>
          </div>
          <div class="pdp-tb">
            <span class="pdp-tb-ic">🚚</span><span class="pdp-tb-tx"><b>Free shipping</b><small>Across India</small></span>
          </div>
        </div>`;
      })()}
      ${rows.length ? `<section class="pdp-section">
          <h2>Full configuration</h2>
          <table class="pdp-spec-table"><tbody>
            ${rows.map((r) => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join('')}
          </tbody></table>
        </section>` : ''}
      ${(!isPhone && m.software) ? `<section class="pdp-section">
        <h2>What can this MacBook run?</h2>
        <p class="pdp-software">${esc(m.software)}</p>
      </section>` : ''}
    </main>
    <script>(function(){var t=document.getElementById('pdpThumbs');if(!t)return;var main=document.getElementById('pdpMainImg');t.addEventListener('click',function(e){var b=e.target.closest('.pdp-thumb');if(!b)return;main.src=b.getAttribute('data-img');t.querySelectorAll('.pdp-thumb').forEach(function(x){x.classList.toggle('on',x===b);});});})();</script>` +
    pageTail()
  );
}

// Category landing page (server-rendered) — lists all products in a category.
router.get('/c/:slug', (req, res) => {
  const cat = catBySlug(req.params.slug);
  if (!cat) return res.status(404).send('Category not found');
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const priceNote = (cat.price_note || '').trim() || getSetting('price_note', '');
  const items = db.prepare('SELECT * FROM macbook_models WHERE category = ? AND active = 1 ORDER BY sort_order ASC, id ASC').all(cat.slug);
  const ld = { '@context': 'https://schema.org', '@type': 'ItemList', name: cat.name,
    itemListElement: items.map((m, i) => ({ '@type': 'ListItem', position: i + 1, url: base + productUrl(m, cat), name: m.name })) };
  const card = (m) => {
    const sub = cat.fields === 'phone'
      ? [m.cpu, m.storage, m.battery_health ? 'Battery ' + m.battery_health : '', m.condition_grade].filter(Boolean).join(' · ')
      : [m.specs || [m.cpu, m.memory, m.storage].filter(Boolean).join(' · '), m.condition_grade].filter(Boolean).join(' · ');
    const so = isSoldOut(m);
    const bd = m.badge ? `<span class="model-badge ${so ? 'soldout' : /hot/i.test(m.badge) ? 'hot' : 'avail'}">${esc(m.badge)}</span>` : '';
    return `<article class="model-card${so ? ' oos' : ''}">
      <div class="model-media">${m.image ? `<img src="${esc(m.image)}" alt="${esc(m.name)}">` : '<div class="model-ph"></div>'}${bd}</div>
      <div class="model-body">
        <h3>${esc(m.name)}</h3>
        ${sub ? `<p class="model-specs">${esc(sub)}</p>` : ''}
        ${m.price ? `<div class="model-price">${esc(m.price)}${discountHtml(m)}${priceNote ? ` <span class="model-gst">${esc(priceNote)}</span>` : ''}</div>` : ''}
        <div class="model-foot">
          ${so ? availabilityButton(m, 'model-reserve model-avail') : reserveButton(m.slug, 'model-reserve')}
          <a class="model-cta" href="${productUrl(m, cat)}">View details →</a>
        </div>
      </div>
    </article>`;
  };
  res.send(
    pageHead(req, cat.name + ' — ' + brand, cat.tagline || cat.name, base + '/c/' + esc(cat.slug), `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`) +
    siteHeaderHtml() +
    `<main class="container page-body">
      <a class="back-link" href="/">← Home</a>
      <h1>${esc(cat.name)}</h1>
      ${cat.tagline ? `<p class="cat-tagline">${esc(cat.tagline)}</p>` : ''}
      ${items.length ? `<div class="models-grid cat-grid-page">${items.map(card).join('')}</div>` : '<p class="muted">New stock coming soon. Please check back or book a consultation.</p>'}
      <p style="margin-top:26px;"><a class="pdp-book" href="/#lead-form">Book a free consultation →</a></p>
    </main>` +
    pageTail()
  );
});

// Condition grades page (server-rendered) — definitions with coloured badges.
router.get('/condition', (req, res) => {
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  let grades = [];
  try { grades = JSON.parse(getSetting('condition_grades', '[]')) || []; } catch { grades = []; }
  const title = getSetting('condition_title', 'Condition grades explained');
  const intro = getSetting('condition_intro', '');
  const cards = grades.map((g) => `
    <div class="cond-card">
      <span class="cond-badge ${gradeBadgeClass(g.grade)}">${esc(g.grade)}</span>
      ${g.summary ? `<p class="cond-summary">${esc(g.summary)}</p>` : ''}
      ${g.detail ? `<p class="cond-detail">${esc(g.detail)}</p>` : ''}
    </div>`).join('');
  res.send(
    pageHead(req, title + ' — ' + brand, intro.slice(0, 180) || title, base + '/condition', '') +
    siteHeaderHtml() +
    `<main class="container page-body cond-page">
      <a class="back-link" href="/">← Home</a>
      <h1>${esc(title)}</h1>
      ${intro ? `<p class="cond-intro">${esc(intro)}</p>` : ''}
      <div class="cond-grid">${cards}</div>
      <p style="margin-top:26px;color:var(--muted);font-size:.9rem;">Every device — regardless of grade — passes our 35-point quality check and comes with a GST invoice and warranty. You can verify your exact unit on a free video call before you pay.</p>
    </main>` +
    pageTail()
  );
});

// Compliance / content page (server-rendered)
router.get('/p/:slug', (req, res) => {
  const page = db.prepare('SELECT * FROM content_pages WHERE slug = ?').get(req.params.slug);
  if (!page) return res.status(404).send('Page not found');
  const brand = esc(getSetting('brand_name', 'Mobirapid'));
  const logo = getSetting('logo_path', '');
  const footer = esc(getSetting('footer_text', ''));
  const pages = db.prepare('SELECT slug, title FROM content_pages ORDER BY sort_order ASC').all();
  const footerLinks = pages
    .map((p) => `<a href="/p/${esc(p.slug)}">${esc(p.title)}</a>`)
    .join(' · ');
  const headCode = getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '')
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '')}"></script>` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '')}');</script>`
    : '';
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(page.title)} — ${brand}</title>
<meta name="description" content="${esc(page.title)} — ${brand}">
<link rel="canonical" href="${baseUrl(req)}/p/${esc(req.params.slug)}">
<link rel="stylesheet" href="${ver('/styles.css')}">
${headCode}${getSetting('head_code', '')}
</head><body>
<header class="site-header"><div class="container header-inner">
  <a class="brand" href="/">${logo ? `<img class="brand-logo" src="${esc(logo)}" alt="${brand}">` : `<span class="brand-mark">${brand.charAt(0)}</span>`}<span class="brand-name">${brand}</span></a>
  <a class="header-cta" href="/#lead-form">${esc(getSetting('header_cta_text', 'Book Consultation'))}</a>
</div></header>
<main class="container page-body">
  <a class="back-link" href="/">← Back to home</a>
  <h1>${esc(page.title)}</h1>
  <div class="page-content">${page.content || ''}</div>
  ${businessDetailsHtml()}
</main>
<footer class="site-footer"><div class="container footer-inner">
  <span>${footer}</span>
  <span class="footer-links">${footerLinks}</span>
</div></footer>
</body></html>`);
});

module.exports = router;
