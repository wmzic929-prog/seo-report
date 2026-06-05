// n8n Code node: SEO Daily Aggregator
// Collects GSC, GA4, GitHub blog counts, PageSpeed CWV
const https = require('https');

function httpsReq(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function refreshOAuth(clientId, clientSecret, refreshToken) {
  const body = 'grant_type=refresh_token' +
    '&client_id=' + encodeURIComponent(clientId) +
    '&client_secret=' + encodeURIComponent(clientSecret) +
    '&refresh_token=' + encodeURIComponent(refreshToken);
  const res = await httpsReq({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  return res.data.access_token;
}

async function fetchGSC(gscProperty, token) {
  const end = new Date(); end.setDate(end.getDate() - 3);
  const start28 = new Date(end); start28.setDate(start28.getDate() - 27);
  const start7 = new Date(end); start7.setDate(start7.getDate() - 6);
  const fmt = d => d.toISOString().slice(0, 10);
  const prop = encodeURIComponent(gscProperty);

  function gscQuery(startDate, endDate, dimensions, rowLimit, orderBy) {
    const body = JSON.stringify({ startDate, endDate, dimensions: dimensions || [], rowLimit: rowLimit || 1, ...(orderBy ? { orderBy } : {}) });
    return httpsReq({ hostname: 'www.googleapis.com', path: '/webmasters/v3/sites/' + prop + '/searchAnalytics/query', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  }

  const [overall28, overall7, kwRes, dailyRes] = await Promise.all([
    gscQuery(fmt(start28), fmt(end)),
    gscQuery(fmt(start7), fmt(end)),
    gscQuery(fmt(start28), fmt(end), ['query'], 10, [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }]),
    gscQuery(fmt(start7), fmt(end), ['date'], 7)
  ]);

  const row28 = overall28.data.rows && overall28.data.rows[0] ? overall28.data.rows[0] : {};
  const row7 = overall7.data.rows && overall7.data.rows[0] ? overall7.data.rows[0] : {};

  // Build 7-day daily series (oldest → newest), fill missing dates with 0
  const dailyMap = {};
  if (dailyRes.data && dailyRes.data.rows) {
    for (const row of dailyRes.data.rows) {
      dailyMap[row.keys[0]] = { imp: Math.round(Number(row.impressions) || 0), clk: Math.round(Number(row.clicks) || 0) };
    }
  }
  const series_7d = { dates: [], impressions: [], clicks: [] };
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end); d.setDate(d.getDate() - i);
    const isoKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const label = (d.getMonth() + 1) + '/' + d.getDate();
    series_7d.dates.push(label);
    series_7d.impressions.push(dailyMap[isoKey] ? dailyMap[isoKey].imp : 0);
    series_7d.clicks.push(dailyMap[isoKey] ? dailyMap[isoKey].clk : 0);
  }

  return {
    impressions_28d: Math.round(Number(row28.impressions) || 0),
    clicks_28d: Math.round(Number(row28.clicks) || 0),
    impressions_7d: Math.round(Number(row7.impressions) || 0),
    clicks_7d: Math.round(Number(row7.clicks) || 0),
    ctr: Math.round((Number(row28.ctr) || 0) * 10000) / 10000,
    avg_position: Math.round((Number(row28.position) || 0) * 10) / 10,
    data_cutoff: fmt(end), // last date GSC data is available; dates after this are pending processing
    series_7d,
    top_keywords: (kwRes.data.rows || []).map(r => ({ kw: r.keys[0], pos: Math.round(Number(r.position) * 10) / 10, impressions: Math.round(Number(r.impressions)) })).sort((a,b) => b.impressions - a.impressions)
  };
}

async function fetchSitemapData(gscProperty, sitemapUrl, token) {
  const sm = encodeURIComponent(sitemapUrl);
  const httpsProperty = sitemapUrl.replace(/\/sitemap\.xml.*$/, '/');

  // Channel 1: Query specific sitemap URL under a given property
  async function trySitemapApi(propStr) {
    try {
      const res = await httpsReq({ hostname: 'www.googleapis.com', path: '/webmasters/v3/sites/' + encodeURIComponent(propStr) + '/sitemaps/' + sm, method: 'GET', headers: { Authorization: 'Bearer ' + token } });
      if (res.data && res.data.contents && res.data.contents[0]) {
        return { total_urls: Number(res.data.contents[0].submitted) || 0, indexed_pages: Number(res.data.contents[0].indexed) || 0 };
      }
    } catch(e) {}
    return { total_urls: 0, indexed_pages: 0 };
  }

  // Channel 2 (GSC Data API): List ALL sitemaps under a property, sum indexed across all entries
  // Catches cases where sitemap index splits into sub-sitemaps each with their own indexed count
  async function tryAllSitemaps(propStr) {
    try {
      const res = await httpsReq({ hostname: 'www.googleapis.com', path: '/webmasters/v3/sites/' + encodeURIComponent(propStr) + '/sitemaps', method: 'GET', headers: { Authorization: 'Bearer ' + token } });
      if (res.data && Array.isArray(res.data.sitemap) && res.data.sitemap.length > 0) {
        let totalIndexed = 0, totalSubmitted = 0;
        for (const s of res.data.sitemap) {
          if (s.contents) for (const c of s.contents) { totalIndexed += Number(c.indexed) || 0; totalSubmitted += Number(c.submitted) || 0; }
        }
        return { total_urls: totalSubmitted, indexed_pages: totalIndexed };
      }
    } catch(e) {}
    return { total_urls: 0, indexed_pages: 0 };
  }

  // Try channel 1 first (specific sitemap, gscProperty)
  let { total_urls, indexed_pages } = await trySitemapApi(gscProperty);

  // If sitemap not found under gscProperty, try channel 1 under HTTPS property
  if (total_urls === 0 && gscProperty !== httpsProperty) {
    const fb = await trySitemapApi(httpsProperty);
    if (fb.total_urls > 0) { total_urls = fb.total_urls; indexed_pages = fb.indexed_pages; }
  }

  // If indexed still 0, try channel 2 (all sitemaps) under gscProperty
  if (indexed_pages === 0) {
    const all = await tryAllSitemaps(gscProperty);
    if (all.indexed_pages > 0) indexed_pages = all.indexed_pages;
    if (total_urls === 0 && all.total_urls > 0) total_urls = all.total_urls;
  }

  // If indexed still 0 and gscProperty is sc-domain, try channel 2 under HTTPS property
  if (indexed_pages === 0 && gscProperty !== httpsProperty) {
    const allHttps = await tryAllSitemaps(httpsProperty);
    if (allHttps.indexed_pages > 0) indexed_pages = allHttps.indexed_pages;
    if (total_urls === 0 && allHttps.total_urls > 0) total_urls = allHttps.total_urls;
  }

  // Channel 3 fallback: searchAnalytics unique pages with impressions (90-day window)
  if (indexed_pages === 0) {
    try {
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(end); start.setDate(start.getDate() - 89);
      const fmt = d => d.toISOString().slice(0, 10);
      const body = JSON.stringify({ startDate: fmt(start), endDate: fmt(end), dimensions: ['page'], rowLimit: 5000 });
      const res = await httpsReq({ hostname: 'www.googleapis.com', path: '/webmasters/v3/sites/' + encodeURIComponent(gscProperty) + '/searchAnalytics/query', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (res.data && Array.isArray(res.data.rows)) indexed_pages = res.data.rows.length;
    } catch(e) {}
  }

  // Channel 4: Serper.dev — Google site: operator organic count (closest to GSC Coverage indexed count)
  // site: queries return organic[] array, NOT searchInformation.totalResults
  // Only used when all GSC API channels return 0, to avoid Serper quota waste
  if (indexed_pages === 0 && SERPER_KEY) {
    try {
      const domain = httpsProperty.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const body = JSON.stringify({ q: 'site:' + domain, num: 10, gl: 'us', hl: 'en' }); // free plan caps site: query at num:10
      const res = await httpsReq({ hostname: 'google.serper.dev', path: '/search', method: 'POST', headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (res.data && Array.isArray(res.data.organic) && res.data.organic.length > 0) {
        indexed_pages = res.data.organic.length;
      }
    } catch(e) {}
  }

  // Channel 5: Direct sitemap.xml fetch — count <loc> elements (authoritative; always run to override GSC's unreliable submitted count)
  if (sitemapUrl) {
    try {
      const smUrl = new URL(sitemapUrl);
      const xmlRes = await httpsReq({ hostname: smUrl.hostname, path: smUrl.pathname + (smUrl.search || ''), method: 'GET', headers: { 'User-Agent': 'SEO-Aggregator/1.0', 'Accept': 'application/xml,text/xml,*/*' } }, null);
      if (typeof xmlRes.data === 'string' && xmlRes.status === 200) {
        const locs = xmlRes.data.match(/<loc>/g);
        if (locs) total_urls = locs.length;
      }
    } catch(e) {}
  }

  return { total_urls, indexed_pages };
}

async function fetchGitHubBlogCount(repo, ghPat) {
  const res = await httpsReq({
    hostname: 'api.github.com',
    path: '/repos/' + repo + '/contents/blog',
    method: 'GET',
    headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' }
  });
  if (!Array.isArray(res.data)) return { total_articles: 0, this_month: 0, this_week: 0 };
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
  // Exclude index.html and _template/_placeholder etc. (non-article files)
  const files = res.data.filter(f => f.name.endsWith('.html') && f.name !== 'index.html' && !f.name.startsWith('_'));
  return { total_articles: files.length, this_month: 0, this_week: 0 };
}

// Returns the count of .html files in `dir` as of the last commit at or before `untilISO` (YYYY-MM-DD).
// Boundary is aligned to HKT midnight (UTC-8h) so articles published at 05:30 HKT appear in the correct day.
async function getFileCountAtDate(repo, dir, untilISO, ghPat) {
  // Shift boundary to HKT midnight: untilISO 00:00 HKT = (untilISO-1) 16:00 UTC
  const hktBound = new Date(untilISO + 'T00:00:00Z');
  hktBound.setHours(hktBound.getHours() - 8);
  const untilHKT = hktBound.toISOString().slice(0, 19) + 'Z';
  const commitRes = await httpsReq({
    hostname: 'api.github.com',
    path: '/repos/' + repo + '/commits?path=' + encodeURIComponent(dir) + '&until=' + untilHKT + '&per_page=1',
    method: 'GET',
    headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' }
  });
  if (!Array.isArray(commitRes.data) || commitRes.data.length === 0) return 0;
  const sha = commitRes.data[0].sha;
  const cdRes = await httpsReq({
    hostname: 'api.github.com',
    path: '/repos/' + repo + '/commits/' + sha,
    method: 'GET',
    headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' }
  });
  const treeSha = cdRes.data && cdRes.data.commit && cdRes.data.commit.tree ? cdRes.data.commit.tree.sha : null;
  if (!treeSha) return 0;
  const treeRes = await httpsReq({
    hostname: 'api.github.com',
    path: '/repos/' + repo + '/git/trees/' + treeSha + '?recursive=1',
    method: 'GET',
    headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' }
  });
  if (!treeRes.data || !Array.isArray(treeRes.data.tree)) return 0;
  return treeRes.data.tree.filter(f => {
    const fname = f.path.split('/').pop();
    return f.type === 'blob' &&
      f.path.startsWith(dir + '/') &&
      f.path.endsWith('.html') &&
      fname !== 'index.html' &&
      !fname.startsWith('_');
  }).length;
}

// Parse sitemap.xml for article publish dates (BDUK uses batch git push; sitemap lastmod is ground truth).
async function fetchSitemapArticleDates(sitemapUrl, blogDir, sportsDir) {
  const dates = { blog: [], sports: [] };
  if (!sitemapUrl) return dates;
  try {
    const smUrl = new URL(sitemapUrl);
    const xmlRes = await httpsReq({
      hostname: smUrl.hostname,
      path: smUrl.pathname + (smUrl.search || ''),
      method: 'GET',
      headers: { 'User-Agent': 'SEO-Aggregator/1.0', 'Accept': 'application/xml,text/xml,*/*' }
    }, null);
    if (typeof xmlRes.data !== 'string' || xmlRes.status !== 200) return dates;
    const urlBlocks = xmlRes.data.match(/<url>[\s\S]*?<\/url>/g) || [];
    for (const block of urlBlocks) {
      const locM = block.match(/<loc>\s*(.*?)\s*<\/loc>/);
      const lastmodM = block.match(/<lastmod>\s*([\d-]+)/);
      if (!locM || !lastmodM) continue;
      const pathPart = locM[1].replace(/^https?:\/\/[^/]+/, '');
      const date = lastmodM[1].slice(0, 10);
      const fname = pathPart.split('/').pop() || '';
      // Accept both clean URLs (/blog/slug) and .html URLs (/blog/slug.html)
      // Exclude index, static pages, and _template files
      if (!fname || fname.startsWith('_') || fname === 'index.html') continue;
      if (blogDir && pathPart.startsWith('/' + blogDir + '/') && pathPart !== '/' + blogDir + '/') dates.blog.push(date);
      else if (sportsDir && pathPart.startsWith('/' + sportsDir + '/') && pathPart !== '/' + sportsDir + '/') dates.sports.push(date);
    }
  } catch(e) { console.error('fetchSitemapArticleDates', sitemapUrl, e.message); }
  return dates;
}

async function fetchArticleDatesFromGitHub(repo, dirs, ghPat, currentCounts) {
  // currentCounts: { blog: N, sports: M } — current total from GitHub contents API
  const recentAdds = { blog: [], sports: [] };
  const since = new Date(); since.setDate(since.getDate() - 60);
  const sinceISO = since.toISOString();

  for (const dir of dirs) {
    const target = dir === 'sports' ? recentAdds.sports : recentAdds.blog;
    let commitsData;
    try {
      const res = await httpsReq({
        hostname: 'api.github.com',
        path: '/repos/' + repo + '/commits?path=' + encodeURIComponent(dir) + '&since=' + sinceISO + '&per_page=100',
        method: 'GET',
        headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' }
      });
      commitsData = res.data;
    } catch(e) { console.error('fetchArticleDates commits', repo, dir, e.message); continue; }

    if (!Array.isArray(commitsData)) { console.error('fetchArticleDates: unexpected commits response', repo, dir); continue; }

    // Parallel fetch all commit details
    const details = await Promise.all(commitsData.map(commit =>
      httpsReq({
        hostname: 'api.github.com',
        path: '/repos/' + repo + '/commits/' + commit.sha,
        method: 'GET',
        headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' }
      }).then(r => ({ date: commit.commit.author.date.slice(0, 10), data: r.data })).catch(() => null)
    ));
    for (const detail of details) {
      if (!detail || !detail.data || !Array.isArray(detail.data.files)) continue;
      for (const file of detail.data.files) {
        if (file.status === 'added' &&
            file.filename.startsWith(dir + '/') &&
            file.filename.endsWith('.html') &&
            !file.filename.endsWith('/index.html')) {
          target.push(detail.date);
        }
      }
    }
  }

  // Old articles (published > 60 days ago) get placeholder '2000-01-01'
  // so they always count for any day in the 7-day window (2000-01-01 <= any recent date)
  const blogOld = Math.max(0, (currentCounts.blog || 0) - recentAdds.blog.length);
  const sportsOld = Math.max(0, (currentCounts.sports || 0) - recentAdds.sports.length);
  const blog = [...Array(blogOld).fill('2000-01-01'), ...recentAdds.blog].sort();
  const sports = [...Array(sportsOld).fill('2000-01-01'), ...recentAdds.sports].sort();
  return { blog, sports, all: [...blog, ...sports].sort() };
}

async function fetchGA4(propertyId, token) {
  const propPath = '/v1beta/properties/' + propertyId + ':runReport';

  function ga4Post(body) {
    const bodyStr = JSON.stringify(body);
    return httpsReq({
      hostname: 'analyticsdata.googleapis.com',
      path: propPath,
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
    }, bodyStr);
  }

  function firstMetric(res, idx) {
    return res.data && res.data.rows && res.data.rows[0]
      ? Number(res.data.rows[0].metricValues[idx].value) || 0
      : 0;
  }

  // sessions today (yesterday = last complete day)
  const rToday = await ga4Post({
    dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
    metrics: [{ name: 'sessions' }]
  });
  if (rToday.status === 403 || rToday.status === 401) return null; // scope insufficient

  const sessions_today = Math.round(firstMetric(rToday, 0));

  // 7d
  const r7d = await ga4Post({
    dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
    metrics: [{ name: 'sessions' }]
  });
  const sessions_7d = Math.round(firstMetric(r7d, 0));

  // 30d overview
  const r30d = await ga4Post({
    dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
    metrics: [{ name: 'sessions' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }]
  });
  const sessions_30d = Math.round(firstMetric(r30d, 0));
  const bounce_rate = Math.round(firstMetric(r30d, 1) * 1000) / 1000;
  const avg_duration_sec = Math.round(firstMetric(r30d, 2));

  // daily series 30d
  const rSeries = await ga4Post({
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
    limit: 31
  });

  // daily CTA clicks (outbound_click + click events) 7d + 28d total (parallel)
  const [rCtaDaily, rCta28] = await Promise.all([
    ga4Post({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['click', 'outbound_click', 'cta_click'] } } },
      orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }]
    }),
    ga4Post({
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['click', 'outbound_click', 'cta_click'] } } }
    })
  ]);
  const cta_clicks_28d = Math.round(firstMetric(rCta28, 0));
  const seriesMap = {};
  if (rSeries.data && rSeries.data.rows) {
    for (const row of rSeries.data.rows) {
      seriesMap[row.dimensionValues[0].value] = Math.round(Number(row.metricValues[0].value) || 0);
    }
  }
  const series_30d = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    series_30d.push(seriesMap[key] || 0);
  }

  // cta_series_7d: daily click events for last 7 days (oldest → newest)
  const ctaMap = {};
  if (rCtaDaily.data && rCtaDaily.data.rows) {
    for (const row of rCtaDaily.data.rows) {
      ctaMap[row.dimensionValues[0].value] = Math.round(Number(row.metricValues[0].value) || 0);
    }
  }
  const cta_series_7d = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i - 1);
    const key = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    cta_series_7d.push(ctaMap[key] || 0);
  }

  // device category (mobile pct)
  const rDevice = await ga4Post({
    dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'deviceCategory' }],
    metrics: [{ name: 'sessions' }]
  });
  let mobileCount = 0, totalDevice = 0;
  if (rDevice.data && rDevice.data.rows) {
    for (const row of rDevice.data.rows) {
      const cnt = Number(row.metricValues[0].value) || 0;
      totalDevice += cnt;
      if (row.dimensionValues[0].value.toLowerCase() === 'mobile') mobileCount += cnt;
    }
  }
  const mobile_pct = totalDevice > 0 ? Math.round(mobileCount / totalDevice * 1000) / 1000 : 0;

  // traffic sources
  const rSrc = await ga4Post({
    dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }]
  });
  let organic = 0, direct = 0, social = 0, referral = 0, totalSrc = 0;
  if (rSrc.data && rSrc.data.rows) {
    for (const row of rSrc.data.rows) {
      const ch = (row.dimensionValues[0].value || '').toLowerCase();
      const cnt = Number(row.metricValues[0].value) || 0;
      totalSrc += cnt;
      if (ch.includes('organic search')) organic += cnt;
      else if (ch === 'direct') direct += cnt;
      else if (ch.includes('social')) social += cnt;
      else if (ch === 'referral') referral += cnt;
    }
  }
  const st = totalSrc || 1;

  return {
    sessions_today,
    sessions_7d,
    sessions_30d,
    series_30d,
    cta_series_7d,
    cta_clicks_28d,
    bounce_rate,
    avg_duration_sec,
    mobile_pct,
    sources: {
      organic: Math.round(organic / st * 100) / 100,
      direct: Math.round(direct / st * 100) / 100,
      social: Math.round(social / st * 100) / 100,
      referral: Math.round(referral / st * 100) / 100
    }
  };
}

function dates30() {
  const labels = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    labels.push((d.getMonth() + 1) + '/' + d.getDate());
  }
  return labels;
}

async function fetchAICrawlers(domain) {
  try {
    const key = encodeURIComponent('ai:' + domain);
    const res = await httpsReq({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/accounts/' + CF_ACCOUNT_ID + '/storage/kv/namespaces/' + CF_KV_NS_ID + '/values/' + key,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + CF_API_TOKEN }
    });
    if (res.status === 200 && res.data && typeof res.data === 'object' && !res.data.errors) return res.data;
    return {};
  } catch(e) { console.error('fetchAICrawlers', domain, e.message); return {}; }
}

async function pushToGitHub(owner, repoName, path, content, ghPat) {
  const encoded = Buffer.from(content).toString('base64');
  const getRes = await httpsReq({
    hostname: 'api.github.com',
    path: '/repos/' + owner + '/' + repoName + '/contents/' + path,
    method: 'GET',
    headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' }
  });
  const sha = getRes.data && getRes.data.sha ? getRes.data.sha : undefined;
  let prevData = null;
  if (getRes.data && getRes.data.content) {
    try {
      prevData = JSON.parse(Buffer.from(getRes.data.content.replace(/\n/g, ''), 'base64').toString('utf8'));
    } catch(e) {}
  }
  const putBody = JSON.stringify({ message: 'chore: update seo-report.json [automated]', content: encoded, ...(sha ? { sha } : {}) });
  const putRes = await httpsReq({
    hostname: 'api.github.com',
    path: '/repos/' + owner + '/' + repoName + '/contents/' + path,
    method: 'PUT',
    headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putBody) }
  }, putBody);
  return { status: putRes.status, prevData };
}

// ===== ALERT DETECTION =====
function detectAlerts(newOutput, prevData) {
  const alerts = [];
  if (!prevData || !prevData.groups) return alerts;
  for (const [groupId, group] of Object.entries(newOutput.groups)) {
    const prevGroup = prevData.groups[groupId];
    if (!prevGroup) continue;
    for (const [domain, site] of Object.entries(group.sites)) {
      const prev = prevGroup.sites && prevGroup.sites[domain];
      if (!prev) continue;
      // Ranking drop >= 5
      const newPos = site.gsc && site.gsc.avg_position;
      const oldPos = prev.gsc && prev.gsc.avg_position;
      if (newPos && oldPos && oldPos > 0 && (newPos - oldPos) >= 5) {
        alerts.push({ type: 'ranking_drop', domain, message: '排名下滑 ' + Math.round(newPos - oldPos) + ' 位（' + oldPos + '→' + newPos + '）' });
      }
      // Traffic drop >= 30%
      const newS = site.traffic && site.traffic.sessions_7d;
      const oldS = prev.traffic && prev.traffic.sessions_7d;
      if (newS !== undefined && oldS && oldS > 10 && newS < oldS * 0.7) {
        alerts.push({ type: 'traffic_drop', domain, message: '7日流量下跌 ' + Math.round((1 - newS / oldS) * 100) + '%（' + oldS + '→' + newS + '）' });
      }
    }
  }
  return alerts;
}

// ===== CREDENTIALS (load from credentials.js — never commit that file) =====
let _creds = {};
try { _creds = require('./credentials.js'); } catch (_) {}
const GH_PAT = process.env.GH_PAT || _creds.GH_PAT;
const GH_PAT_BDUK = process.env.GH_PAT_BDUK || _creds.GH_PAT_BDUK;
const GH_OWNER = process.env.GH_OWNER || _creds.GH_OWNER || 'wmzic929-prog';
const GH_REPO_NAME = process.env.GH_REPO_NAME || _creds.GH_REPO_NAME || 'seo-report';
const GH_PATH = process.env.GH_PATH || _creds.GH_PATH || 'seo-data/seo-report.json';
const GSC_CLIENT_ID = process.env.GSC_CLIENT_ID || _creds.GSC_CLIENT_ID;
const GSC_CLIENT_SECRET = process.env.GSC_CLIENT_SECRET || _creds.GSC_CLIENT_SECRET;
const GSC_REFRESH_TOKEN = process.env.GSC_REFRESH_TOKEN || _creds.GSC_REFRESH_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || _creds.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN || _creds.CF_API_TOKEN;
const CF_KV_NS_ID = process.env.CF_KV_NS_ID || _creds.CF_KV_NS_ID;
const SERPER_KEY = process.env.SERPER_KEY || _creds.SERPER_KEY;

// ===== SITES CONFIG =====
const GROUPS_CONFIG = [
  {
    id: 'spheretap',
    name: 'Spheretap 集團',
    phases: { 0: ['matchvangtage.com','tableedge.org','turf-pulse.com','spin-metrics.com','verifiedplays.com'], 1: ['matchdatalab.com','athlete-index.com','esports-intel.com','proplayerstat.com','tilestrategist.com','gamedesignhq.com','platformverdict.com','probdecision.com','asiaesportculture.com','entertaintrendlab.com'] },
    sites: [
      { domain: 'spheretap.com', label: 'Spheretap 主站', role: 'main', ga4_id: '536117032', gsc: 'sc-domain:spheretap.com', repo: 'wmzic929-prog/spheretap', sitemap: 'https://spheretap.com/sitemap.xml', sports_dir: 'sports' },
      { domain: 'matchvangtage.com', label: '體育博彩攻略', role: 'satellite', ga4_id: '537749184', gsc: 'sc-domain:matchvangtage.com', repo: 'wmzic929-prog/matchvantage', sitemap: 'https://matchvangtage.com/sitemap.xml' },
      { domain: 'tableedge.org', label: '真人遊戲技術流', role: 'satellite', ga4_id: '537732852', gsc: 'sc-domain:tableedge.org', repo: 'wmzic929-prog/tableedge', sitemap: 'https://tableedge.org/sitemap.xml' },
      { domain: 'turf-pulse.com', label: '香港賽馬技術分析', role: 'satellite', ga4_id: '537747885', gsc: 'sc-domain:turf-pulse.com', repo: 'wmzic929-prog/turf-pulse', sitemap: 'https://turf-pulse.com/sitemap.xml' },
      { domain: 'spin-metrics.com', label: '老虎機遊戲解析', role: 'satellite', ga4_id: '537720331', gsc: 'sc-domain:spin-metrics.com', repo: 'wmzic929-prog/spin-metrics', sitemap: 'https://spin-metrics.com/sitemap.xml' },
      { domain: 'verifiedplays.com', label: '平台技術評測', role: 'satellite', ga4_id: '537741740', gsc: 'sc-domain:verifiedplays.com', repo: 'wmzic929-prog/verifiedplays', sitemap: 'https://verifiedplays.com/sitemap.xml' },
      // Phase 1 — URL-prefix GSC properties (verified 2026-05-25)
      { domain: 'matchdatalab.com', label: '競技運動數據研究', role: 'satellite', ga4_id: '538899166', gsc: 'https://matchdatalab.com/', repo: 'wmzic929-prog/matchdatalab-com', sitemap: 'https://matchdatalab.com/sitemap.xml' },
      { domain: 'athlete-index.com', label: '運動科學與表現', role: 'satellite', ga4_id: '538889268', gsc: 'https://athlete-index.com/', repo: 'wmzic929-prog/athlete-index-com', sitemap: 'https://athlete-index.com/sitemap.xml' },
      { domain: 'esports-intel.com', label: '電競產業研究', role: 'satellite', ga4_id: '538917346', gsc: 'https://esports-intel.com/', repo: 'wmzic929-prog/esports-intel-com', sitemap: 'https://esports-intel.com/sitemap.xml' },
      { domain: 'proplayerstat.com', label: '電競選手數據庫', role: 'satellite', ga4_id: '538862816', gsc: 'https://proplayerstat.com/', repo: 'wmzic929-prog/proplayerstat-com', sitemap: 'https://proplayerstat.com/sitemap.xml' },
      { domain: 'tilestrategist.com', label: '棋牌博弈論研究院', role: 'satellite', ga4_id: '538868124', gsc: 'https://tilestrategist.com/', repo: 'wmzic929-prog/tilestrategist-com', sitemap: 'https://tilestrategist.com/sitemap.xml' },
      { domain: 'gamedesignhq.com', label: '策略遊戲設計分析', role: 'satellite', ga4_id: '538882745', gsc: 'https://gamedesignhq.com/', repo: 'wmzic929-prog/gamedesignhq-com', sitemap: 'https://gamedesignhq.com/sitemap.xml' },
      { domain: 'platformverdict.com', label: '娛樂平台深度評測', role: 'satellite', ga4_id: '538873640', gsc: 'https://platformverdict.com/', repo: 'wmzic929-prog/platformverdict-com', sitemap: 'https://platformverdict.com/sitemap.xml' },
      { domain: 'probdecision.com', label: '概率與決策科學', role: 'satellite', ga4_id: '538861622', gsc: 'https://probdecision.com/', repo: 'wmzic929-prog/probdecision-com', sitemap: 'https://probdecision.com/sitemap.xml' },
      { domain: 'asiaesportculture.com', label: '亞洲電競文化', role: 'satellite', ga4_id: '538918051', gsc: 'https://asiaesportculture.com/', repo: 'wmzic929-prog/asiaesportculture-com', sitemap: 'https://asiaesportculture.com/sitemap.xml' },
      { domain: 'entertaintrendlab.com', label: '數字娛樂消費研究', role: 'satellite', ga4_id: '538861326', gsc: 'https://entertaintrendlab.com/', repo: 'wmzic929-prog/entertaintrendlab-com', sitemap: 'https://entertaintrendlab.com/sitemap.xml' }
    ]
  },
  {
    id: 'bduk',
    name: 'BDUK',
    gh_pat: GH_PAT_BDUK,
    useSitemapDates: true, // BDUK uses batch git push; sitemap lastmod is the accurate publish date source
    phases: {
      0: ['bountifultriathlon.com','besedkibg.com','topbravi.com','dealer-index.com','ogradabg.com'],
      1: ['track-index.com','reel-base.com','spin-vaults.com','feuerwehr-georgenhausen.com','platform-benchmark.com','abcosvetlenie.com','cryptocurrency-game.com','sports-analy.com','esports-index.com','clan-guide.com'],
      2: ['world-cup-2026.world','premier-leagueodds.online','formulaone.site','uk-horse-racing.site','tennis-grandslam.site','golfodds.site','boxingmma.site','rugbyunion.site','dartsodds.site','snookerodds.site','cricketodds.site','bjstrategy.site','pokerstrategy.site','accumulator-guide.site','live-inplay-odds.site']
    },
    sites: [
      { domain: 'businessdirectory-uk.com', label: 'BDUK 主站', role: 'main', ga4_id: '539457824', gsc: 'https://businessdirectory-uk.com/', repo: 'slin41896-gif/businessdirectory-uk', sitemap: 'https://businessdirectory-uk.com/sitemap.xml', sports_dir: 'sports' },
      { domain: 'bountifultriathlon.com',      label: '博彩統計中心',   role: 'satellite', ga4_id: '539472240', gsc: 'https://bountifultriathlon.com/',      repo: 'slin41896-gif/bountifultriathlon-com',      sitemap: 'https://bountifultriathlon.com/sitemap.xml' },
      { domain: 'besedkibg.com',               label: '比賽數據倉庫',   role: 'satellite', ga4_id: '539472956', gsc: 'https://besedkibg.com/',               repo: 'slin41896-gif/besedkibg-com',               sitemap: 'https://besedkibg.com/sitemap.xml' },
      { domain: 'topbravi.com',                label: '賭場數據區',     role: 'satellite', ga4_id: '539479785', gsc: 'https://topbravi.com/',                repo: 'slin41896-gif/topbravi-com',                sitemap: 'https://topbravi.com/sitemap.xml' },
      { domain: 'dealer-index.com',            label: '桌遊實驗室',     role: 'satellite', ga4_id: '539463325', gsc: 'https://dealer-index.com/',            repo: 'slin41896-gif/dealer-index-com',            sitemap: 'https://dealer-index.com/sitemap.xml' },
      { domain: 'ogradabg.com',                label: '賽馬分析',       role: 'satellite', ga4_id: '539496860', gsc: 'https://ogradabg.com/',                repo: 'slin41896-gif/ogradabg-com',                sitemap: 'https://ogradabg.com/sitemap.xml' },
      { domain: 'track-index.com',             label: '賽道數據庫',     role: 'satellite', ga4_id: '539496861', gsc: 'https://track-index.com/',             repo: 'slin41896-gif/track-index-com',             sitemap: 'https://track-index.com/sitemap.xml' },
      { domain: 'reel-base.com',               label: '老虎機研究室',   role: 'satellite', ga4_id: '539494234', gsc: 'https://reel-base.com/',               repo: 'slin41896-gif/reel-base-com',               sitemap: 'https://reel-base.com/sitemap.xml' },
      { domain: 'spin-vaults.com',             label: '老虎機索引',     role: 'satellite', ga4_id: '539457097', gsc: 'https://spin-vaults.com/',             repo: 'slin41896-gif/spin-vaults-com',             sitemap: 'https://spin-vaults.com/sitemap.xml' },
      { domain: 'feuerwehr-georgenhausen.com', label: '賭場審計區',     role: 'satellite', ga4_id: '539496758', gsc: 'https://feuerwehr-georgenhausen.com/', repo: 'slin41896-gif/feuerwehr-georgenhausen-com', sitemap: 'https://feuerwehr-georgenhausen.com/sitemap.xml' },
      { domain: 'platform-benchmark.com',      label: '平台基準測試',   role: 'satellite', ga4_id: '539465376', gsc: 'https://platform-benchmark.com/',      repo: 'slin41896-gif/platform-benchmark-com',      sitemap: 'https://platform-benchmark.com/sitemap.xml' },
      { domain: 'abcosvetlenie.com',           label: '電競博彩數據',   role: 'satellite', ga4_id: '539476060', gsc: 'https://abcosvetlenie.com/',           repo: 'slin41896-gif/abcosvetlenie-com',           sitemap: 'https://abcosvetlenie.com/sitemap.xml' },
      { domain: 'cryptocurrency-game.com',     label: '加密遊戲索引',   role: 'satellite', ga4_id: '539467977', gsc: 'https://cryptocurrency-game.com/',     repo: 'slin41896-gif/cryptocurrency-game-com',     sitemap: 'https://cryptocurrency-game.com/sitemap.xml' },
      { domain: 'sports-analy.com',            label: '賽事統計區',     role: 'satellite', ga4_id: '539490709', gsc: 'https://sports-analy.com/',            repo: 'slin41896-gif/sports-analy-com',            sitemap: 'https://sports-analy.com/sitemap.xml' },
      { domain: 'esports-index.com',           label: '電競成長實驗室', role: 'satellite', ga4_id: '539472242', gsc: 'https://esports-index.com/',           repo: 'slin41896-gif/esports-index-com',           sitemap: 'https://esports-index.com/sitemap.xml' },
      { domain: 'clan-guide.com',              label: '策略遊戲指南',   role: 'satellite', ga4_id: '539476061', gsc: 'https://clan-guide.com/',              repo: 'slin41896-gif/clan-guide-com',              sitemap: 'https://clan-guide.com/sitemap.xml' },
      // Phase 2
      { domain: 'world-cup-2026.world',     label: 'FIFA世界盃2026賠率分析', role: 'satellite', ga4_id: '540064969', gsc: 'https://world-cup-2026.world/',     repo: 'slin41896-gif/world-cup-2026-world',     sitemap: 'https://world-cup-2026.world/sitemap.xml' },
      { domain: 'premier-leagueodds.online',label: '英超讓球盤口研究',       role: 'satellite', ga4_id: '540110071', gsc: 'https://premier-leagueodds.online/',repo: 'slin41896-gif/premier-leagueodds-online', sitemap: 'https://premier-leagueodds.online/sitemap.xml' },
      { domain: 'formulaone.site',          label: 'F1賠率研究',             role: 'satellite', ga4_id: '540061530', gsc: 'https://formulaone.site/',          repo: 'slin41896-gif/formulaone-site',          sitemap: 'https://formulaone.site/sitemap.xml' },
      { domain: 'uk-horse-racing.site',     label: '英國賽馬分析',           role: 'satellite', ga4_id: '540077985', gsc: 'https://uk-horse-racing.site/',     repo: 'slin41896-gif/uk-horse-racing-site',     sitemap: 'https://uk-horse-racing.site/sitemap.xml' },
      { domain: 'tennis-grandslam.site',    label: '大滿貫網球賠率',         role: 'satellite', ga4_id: '540051541', gsc: 'https://tennis-grandslam.site/',    repo: 'slin41896-gif/tennis-grandslam-site',    sitemap: 'https://tennis-grandslam.site/sitemap.xml' },
      { domain: 'golfodds.site',            label: '高爾夫大賽賠率',         role: 'satellite', ga4_id: '540080195', gsc: 'https://golfodds.site/',            repo: 'slin41896-gif/golfodds-site',            sitemap: 'https://golfodds.site/sitemap.xml' },
      { domain: 'boxingmma.site',           label: '拳擊MMA賠率',            role: 'satellite', ga4_id: '540096719', gsc: 'https://boxingmma.site/',           repo: 'slin41896-gif/boxingmma-site',           sitemap: 'https://boxingmma.site/sitemap.xml' },
      { domain: 'rugbyunion.site',          label: '橄欖球聯賽賠率',         role: 'satellite', ga4_id: '540076787', gsc: 'https://rugbyunion.site/',          repo: 'slin41896-gif/rugbyunion-site',          sitemap: 'https://rugbyunion.site/sitemap.xml' },
      { domain: 'dartsodds.site',           label: 'PDC飛鏢賠率',            role: 'satellite', ga4_id: '540078326', gsc: 'https://dartsodds.site/',           repo: 'slin41896-gif/dartsodds-site',           sitemap: 'https://dartsodds.site/sitemap.xml' },
      { domain: 'snookerodds.site',         label: '斯諾克賠率',             role: 'satellite', ga4_id: '540097215', gsc: 'https://snookerodds.site/',         repo: 'slin41896-gif/snookerodds-site',         sitemap: 'https://snookerodds.site/sitemap.xml' },
      { domain: 'cricketodds.site',         label: '板球投注分析',           role: 'satellite', ga4_id: '540103717', gsc: 'https://cricketodds.site/',         repo: 'slin41896-gif/cricketodds-site',         sitemap: 'https://cricketodds.site/sitemap.xml' },
      { domain: 'bjstrategy.site',          label: '21點基礎策略',           role: 'satellite', ga4_id: '540113799', gsc: 'https://bjstrategy.site/',          repo: 'slin41896-gif/bjstrategy-site',          sitemap: 'https://bjstrategy.site/sitemap.xml' },
      { domain: 'pokerstrategy.site',       label: '德州撲克策略',           role: 'satellite', ga4_id: '540106152', gsc: 'https://pokerstrategy.site/',       repo: 'slin41896-gif/pokerstrategy-site',       sitemap: 'https://pokerstrategy.site/sitemap.xml' },
      { domain: 'accumulator-guide.site',   label: '串關策略',               role: 'satellite', ga4_id: '540075878', gsc: 'https://accumulator-guide.site/',   repo: 'slin41896-gif/accumulator-guide-site',   sitemap: 'https://accumulator-guide.site/sitemap.xml' },
      { domain: 'live-inplay-odds.site',    label: '即時投注策略',           role: 'satellite', ga4_id: '540051542', gsc: 'https://live-inplay-odds.site/',    repo: 'slin41896-gif/live-inplay-odds-site',    sitemap: 'https://live-inplay-odds.site/sitemap.xml' }
    ]
  }
];

// ===== MAIN =====
let gscToken;
try { gscToken = await refreshOAuth(GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN); } catch(e) { console.error('GSC token:', e.message); }

const now = new Date();
const genAt = now.toISOString().replace(/\.\d+Z$/, '+08:00');
const labels30 = dates30();
const output = { generated_at: genAt, groups: {} };

for (const group of GROUPS_CONFIG) {
  const siteEntries = await Promise.all(group.sites.map(async (site) => {
    const ghPat = group.gh_pat || GH_PAT;
    const siteData = {
      label: site.label,
      role: site.role,
      traffic: { sessions_today: 0, sessions_7d: 0, sessions_30d: 0, series_30d: new Array(30).fill(0), cta_series_7d: new Array(7).fill(0), bounce_rate: 0, avg_duration_sec: 0, mobile_pct: 0, sources: { organic: 0, direct: 0, social: 0, referral: 0 } },
      cta: { clicks_today: 0, clicks_7d: 0, clicks_28d: 0, unique_clicks_7d: 0, conversions_today: 0, conversions_7d: 0 },
      gsc: { impressions_28d: 0, clicks_28d: 0, impressions_7d: 0, clicks_7d: 0, ctr: 0, avg_position: 0, indexed_pages: 0, series_7d: { dates: [], impressions: [], clicks: [] }, top_keywords: [] },
      sitemap: { total_urls: 0 },
      content: { total_articles: 0, this_month: 0, this_week: 0, this_28d: 0, sports_articles: 0 },
      cwv: {},
      social: { fb_posts: 0 }
    };

    if (gscToken) {
      if (site.gsc) {
        try { const g = await fetchGSC(site.gsc, gscToken); Object.assign(siteData.gsc, g); } catch(e) { console.error('GSC', site.domain, e.message); }
        try { const s = await fetchSitemapData(site.gsc, site.sitemap, gscToken); siteData.sitemap.total_urls = s.total_urls; siteData.gsc.indexed_pages = s.indexed_pages; } catch(e) { console.error('sitemapData', site.domain, e.message); }
      }
      if (site.ga4_id) {
        try {
          const ga4 = await fetchGA4(site.ga4_id, gscToken);
          if (ga4) {
            siteData.cta.clicks_28d = ga4.cta_clicks_28d || 0;
            delete ga4.cta_clicks_28d;
            Object.assign(siteData.traffic, ga4);
            siteData.cta.clicks_7d = (siteData.traffic.cta_series_7d || []).reduce((a,v)=>a+v, 0);
            siteData.cta.clicks_today = (siteData.traffic.cta_series_7d || []).slice(-1)[0] || 0;
          }
          else console.error('GA4 scope insufficient for', site.domain);
        } catch(e) { console.error('GA4', site.domain, e.message); }
      }
    }

    // Channel 5 fallback (no token needed): direct sitemap.xml fetch for total_urls.
    // Runs even when gscToken is unavailable so total_urls is populated regardless of OAuth state.
    if (!siteData.sitemap.total_urls && site.sitemap) {
      try {
        const smUrl5 = new URL(site.sitemap);
        const xml5 = await httpsReq({ hostname: smUrl5.hostname, path: smUrl5.pathname + (smUrl5.search || ''), method: 'GET', headers: { 'User-Agent': 'SEO-Aggregator/1.0', 'Accept': 'application/xml,text/xml,*/*' } }, null);
        if (typeof xml5.data === 'string' && xml5.status === 200) {
          const locs5 = xml5.data.match(/<loc>/g);
          if (locs5) siteData.sitemap.total_urls = locs5.length;
        }
      } catch(e) {}
    }

    try { const gh = await fetchGitHubBlogCount(site.repo, ghPat); Object.assign(siteData.content, gh); } catch(e) { console.error('githubBlog', site.domain, e.message); }
    if (site.sports_dir) {
      try {
        const sportsRes = await httpsReq({ hostname: 'api.github.com', path: '/repos/' + site.repo + '/contents/' + site.sports_dir, method: 'GET', headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' } });
        if (Array.isArray(sportsRes.data)) siteData.content.sports_articles = sportsRes.data.filter(f => f.name.endsWith('.html') && f.name !== 'index.html').length;
      } catch(e) { console.error('sportsList', site.domain, e.message); }
    }

    // Compute this_month / this_week / this_28d and daily_7d article counts.
    // Strategy A (BDUK, useSitemapDates): sitemap <lastmod> is the accurate publish date —
    //   BDUK uses batch git push so GitHub commit timestamps are unreliable.
    // Strategy B (Spheretap): GitHub Tree API diff between boundary dates (HKT-aligned).
    const now2 = new Date();
    const yest2 = new Date(now2); yest2.setDate(yest2.getDate() - 1);
    const yesterdayISO = yest2.getFullYear() + '-' + String(yest2.getMonth()+1).padStart(2,'0') + '-' + String(yest2.getDate()).padStart(2,'0');
    const monthISO = now2.getFullYear() + '-' + String(now2.getMonth()+1).padStart(2,'0') + '-01';
    const weekD2 = new Date(now2); weekD2.setDate(weekD2.getDate() - 7);
    const weekISO = weekD2.getFullYear() + '-' + String(weekD2.getMonth()+1).padStart(2,'0') + '-' + String(weekD2.getDate()).padStart(2,'0');
    const day28D = new Date(now2); day28D.setDate(day28D.getDate() - 28);
    const day28ISO = day28D.getFullYear() + '-' + String(day28D.getMonth()+1).padStart(2,'0') + '-' + String(day28D.getDate()).padStart(2,'0');

    const gscCutoff = siteData.gsc && siteData.gsc.data_cutoff ? siteData.gsc.data_cutoff : null;

    if (group.useSitemapDates && site.sitemap) {
      // === Strategy A: Sitemap lastmod-based counting (BDUK) ===
      let sitemapDates = { blog: [], sports: [] };
      try { sitemapDates = await fetchSitemapArticleDates(site.sitemap, 'blog', site.sports_dir || null); } catch(e) { console.error('sitemapDates', site.domain, e.message); }
      const blogDates = sitemapDates.blog;
      const sportsDatesS = sitemapDates.sports;
      siteData.content.total_articles = blogDates.length;
      if (site.sports_dir) siteData.content.sports_articles = sportsDatesS.length;
      siteData.content.this_month = blogDates.filter(d => d >= monthISO).length + sportsDatesS.filter(d => d >= monthISO).length;
      siteData.content.this_week  = blogDates.filter(d => d >= weekISO).length  + sportsDatesS.filter(d => d >= weekISO).length;
      siteData.content.this_28d   = blogDates.filter(d => d >= day28ISO).length + sportsDatesS.filter(d => d >= day28ISO).length;
      siteData.content.total_articles_inc_sports = blogDates.length + sportsDatesS.length;
      const daily_7d_sm = [];
      for (let j = 0; j < 7; j++) {
        const daysAgo = 7 - j;
        const d = new Date(now2); d.setDate(d.getDate() - daysAgo);
        const dateLabel = (d.getMonth() + 1) + '/' + d.getDate();
        const isoDate = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        const sessions = siteData.traffic.series_30d[29 - daysAgo] || 0;
        const cta = siteData.traffic.cta_series_7d[j] || 0;
        const gscIdx = siteData.gsc.series_7d && siteData.gsc.series_7d.dates ? siteData.gsc.series_7d.dates.indexOf(dateLabel) : -1;
        const gsc_imp = gscIdx >= 0 ? siteData.gsc.series_7d.impressions[gscIdx] : null;
        const gsc_clk = gscIdx >= 0 ? siteData.gsc.series_7d.clicks[gscIdx] : null;
        const gsc_pending = gscCutoff ? isoDate > gscCutoff : false;
        const articles = blogDates.filter(dd => dd === isoDate).length + sportsDatesS.filter(dd => dd === isoDate).length;
        daily_7d_sm.push({ date: dateLabel, sessions, gsc_imp, gsc_clk, cta_clk: cta, articles, gsc_pending });
      }
      siteData.daily_7d = daily_7d_sm;

    } else {
      // === Strategy B: GitHub Tree API boundary diff (Spheretap) ===
      // 8 daily boundary dates: now-8d through now-1d (yesterday)
      // blogDailyCounts[i] = blog file count at start of dailyBoundaryISOs[i]
      // articles added on day j = blogDailyCounts[j+2] - blogDailyCounts[j+1] (j<6)
      //                         = total_articles - blogDailyCounts[7]             (j=6)
      const dailyBoundaryISOs = [];
      for (let di = 8; di >= 1; di--) {
        const bd = new Date(now2); bd.setDate(bd.getDate() - di);
        dailyBoundaryISOs.push(bd.getFullYear() + '-' + String(bd.getMonth()+1).padStart(2,'0') + '-' + String(bd.getDate()).padStart(2,'0'));
      }

      // Blog: all boundary counts in one parallel batch (month/week/28d + 8 daily)
      const allBlogCounts = await Promise.all([
        getFileCountAtDate(site.repo, 'blog', monthISO, ghPat).catch(() => 0),
        getFileCountAtDate(site.repo, 'blog', weekISO, ghPat).catch(() => 0),
        getFileCountAtDate(site.repo, 'blog', day28ISO, ghPat).catch(() => 0),
        ...dailyBoundaryISOs.map(d => getFileCountAtDate(site.repo, 'blog', d, ghPat).catch(() => 0))
      ]);
      const blogAtMonth = allBlogCounts[0];
      const blogAtWeek  = allBlogCounts[1];
      const blogAt28    = allBlogCounts[2];
      const blogDailyCounts = allBlogCounts.slice(3); // [0]=now-8d .. [7]=now-1d=yesterday

      siteData.content.this_month = Math.max(0, siteData.content.total_articles - blogAtMonth);
      siteData.content.this_week  = Math.max(0, siteData.content.total_articles - blogAtWeek);
      siteData.content.this_28d   = Math.max(0, siteData.content.total_articles - blogAt28);

      // Sports: parse publish date from filename YYYY-MM-DD-*.html
      let sportsDates = [];
      if (site.sports_dir) {
        try {
          const sListRes = await httpsReq({
            hostname: 'api.github.com',
            path: '/repos/' + site.repo + '/contents/' + site.sports_dir,
            method: 'GET',
            headers: { Authorization: 'token ' + ghPat, 'User-Agent': 'n8n-seo-aggregator', Accept: 'application/vnd.github.v3+json' }
          });
          if (Array.isArray(sListRes.data)) {
            const dateRe = /^(\d{4}-\d{2}-\d{2})-/;
            sportsDates = sListRes.data
              .filter(f => f.name.endsWith('.html') && f.name !== 'index.html' && !f.name.startsWith('_') && dateRe.test(f.name))
              .map(f => f.name.match(dateRe)[1])
              .filter(d => d <= yesterdayISO);
            siteData.content.sports_articles = sportsDates.length;
            siteData.content.this_month += sportsDates.filter(d => d >= monthISO).length;
            siteData.content.this_week  += sportsDates.filter(d => d >= weekISO).length;
            siteData.content.this_28d   += sportsDates.filter(d => d >= day28ISO).length;
          }
        } catch(e) { console.error('sportsDates', site.domain, e.message); }
      }

      // Build unified 7-day daily data (oldest→newest)
      const daily_7d = [];
      for (let j = 0; j < 7; j++) {
        const daysAgo = 7 - j;
        const d = new Date(now2); d.setDate(d.getDate() - daysAgo);
        const dateLabel = (d.getMonth() + 1) + '/' + d.getDate();
        const isoDate = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        const sessions = siteData.traffic.series_30d[29 - daysAgo] || 0;
        const cta = siteData.traffic.cta_series_7d[j] || 0;
        const gscIdx = siteData.gsc.series_7d && siteData.gsc.series_7d.dates ? siteData.gsc.series_7d.dates.indexOf(dateLabel) : -1;
        const gsc_imp = gscIdx >= 0 ? siteData.gsc.series_7d.impressions[gscIdx] : null;
        const gsc_clk = gscIdx >= 0 ? siteData.gsc.series_7d.clicks[gscIdx] : null;
        const gsc_pending = gscCutoff ? isoDate > gscCutoff : false;
        // Per-day new blog = diff between consecutive boundary counts (j+2 vs j+1)
        // For last day (j=6): total_articles - blogDailyCounts[7]
        const blogToday = j < 6
          ? Math.max(0, blogDailyCounts[j+2] - blogDailyCounts[j+1])
          : Math.max(0, siteData.content.total_articles - blogDailyCounts[7]);
        const sportsToday = sportsDates.filter(d => d === isoDate).length;
        const articles = blogToday + sportsToday;
        daily_7d.push({ date: dateLabel, sessions, gsc_imp, gsc_clk, cta_clk: cta, articles, gsc_pending });
      }
      siteData.daily_7d = daily_7d;
      siteData.content.total_articles_inc_sports = siteData.content.total_articles + (siteData.content.sports_articles || 0);
    } // end strategy branch

    // Fetch AI crawler visit data from CF KV
    try { siteData.ai_crawlers = await fetchAICrawlers(site.domain); } catch(e) { siteData.ai_crawlers = {}; }

    return [site.domain, siteData];
  }));
  const groupSites = {};
  for (const [domain, data] of siteEntries) {
    groupSites[domain] = data;
  }
  output.groups[group.id] = { name: group.name, phases: group.phases || {}, dates_30d: labels30, sites: groupSites };
}

const jsonStr = JSON.stringify(output, null, 2);
const pushRes = await pushToGitHub(GH_OWNER, GH_REPO_NAME, GH_PATH, jsonStr, GH_PAT);
// Detect alerts by comparing with previous data
const alerts = detectAlerts(output, pushRes.prevData);
// If alerts exist, push again with alerts embedded
if (alerts.length > 0) {
  output.alerts = alerts;
  await pushToGitHub(GH_OWNER, GH_REPO_NAME, GH_PATH, JSON.stringify(output, null, 2), GH_PAT);
}
console.log('GitHub push status:', pushRes.status, 'alerts:', alerts.length);

return [{ json: { success: true, generated_at: output.generated_at, github_status: pushRes.status, alert_count: alerts.length } }];
