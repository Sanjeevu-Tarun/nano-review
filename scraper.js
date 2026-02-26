/**
 * scraper.js
 * - Direct HTTP fast path for search API (JSON, no browser needed)
 * - Full browser scraping for device/compare/ranking pages
 *   (Cloudflare requires real browser; selectors match nanoreview's real DOM)
 * - Cache layer on top of everything
 */
import * as cheerio from 'cheerio';
import { getBrowserContext, waitForCloudflare, safeNavigate } from './browser.js';
import { cache, TTL } from './cache.js';
import { directSearch } from './http.js';

// ── Type detection ─────────────────────────────────────────────────────────

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd\s*(ryzen|fx|a\d)|phenom/i.test(q))
        return ['cpu', 'laptop', 'soc', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]|titan/i.test(q))
        return ['gpu', 'laptop', 'cpu'];
    if (/snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic|kirin|tensor/i.test(q))
        return ['soc', 'phone', 'tablet'];
    if (/iphone|galaxy\s*s|galaxy\s*note|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|asus\s*rog\s*phone|poco/i.test(q))
        return ['phone', 'soc', 'tablet'];
    if (/ipad|galaxy\s*tab|surface\s*pro|tab\s*s[0-9]|kindle\s*fire/i.test(q))
        return ['tablet', 'phone', 'soc'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook|pavilion|inspiron/i.test(q))
        return ['laptop', 'cpu', 'gpu'];
    return ['phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet'];
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase();
    const ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.startsWith(ql)) return 800;
    if (n.includes(ql)) return 500;
    const words = ql.split(/\s+/);
    let score = 0;
    for (const w of words) if (n.includes(w)) score += 10;
    return score - (n.length * 0.05);
};

// ── Browser helper: launch fresh browser, navigate, return page ───────────

async function withBrowserPage(url, blockTypes, fn) {
    const { browser, context } = await getBrowserContext();
    try {
        const page = await context.newPage();

        // Block unnecessary resources
        await page.route('**/*', (route) => {
            if (blockTypes.includes(route.request().resourceType())) route.abort();
            else route.continue();
        });

        await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Wait for Cloudflare to clear
        try {
            await waitForCloudflare(page, 'body', 12000);
        } catch {
            // If CF check times out, try to proceed anyway
        }

        // Extra settle time for JS-rendered content
        await page.waitForTimeout(1500);

        return await fn(page);
    } finally {
        await browser.close().catch(() => {});
    }
}

// ── Device page scraper ────────────────────────────────────────────────────
// Uses page.evaluate() to extract data directly from the live DOM,
// matching nanoreview.net's actual element structure.

async function browserScrapeDevice(deviceUrl) {
    return withBrowserPage(deviceUrl, ['font', 'media'], async (page) => {
        return await page.evaluate((sourceUrl) => {
            const data = {
                title: '',
                sourceUrl,
                images: [],
                scores: {},
                pros: [],
                cons: [],
                specs: {},
            };

            // ── Title ──────────────────────────────────────────────────────
            const h1 = document.querySelector('h1');
            data.title = h1 ? h1.textContent.trim() : document.title;

            // ── Images ────────────────────────────────────────────────────
            const seen = new Set();
            document.querySelectorAll('img').forEach(img => {
                const candidates = [
                    img.getAttribute('src'),
                    img.getAttribute('data-src'),
                    img.getAttribute('data-lazy-src'),
                ];
                // also check srcset
                const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
                srcset.split(',').forEach(s => {
                    const u = s.trim().split(' ')[0];
                    if (u) candidates.push(u);
                });
                candidates.forEach(src => {
                    if (!src) return;
                    if (src.startsWith('/')) src = 'https://nanoreview.net' + src;
                    if (!src.startsWith('http')) return;
                    const l = src.toLowerCase();
                    if (l.includes('logo') || l.includes('icon') || l.includes('avatar') || l.includes('svg') || l.includes('sprite')) return;
                    if (!seen.has(src)) { seen.add(src); data.images.push(src); }
                });
            });

            // ── Scores ────────────────────────────────────────────────────
            // nanoreview uses elements like .main-score, .sub-score, [class*="score"]
            // Try multiple selector patterns
            const scoreSelectors = [
                '[class*="score-value"]',
                '[class*="rating-value"]',
                '.score .value',
                '.rating .value',
                '[class*="benchmark"] [class*="value"]',
            ];
            document.querySelectorAll('[class*="score"], [class*="rating"], [class*="benchmark"]').forEach(el => {
                // Look for a label + value pair within
                const labelEl = el.querySelector('[class*="label"], [class*="title"], [class*="name"], h3, h4, p');
                const valueEl = el.querySelector('[class*="value"], [class*="num"], [class*="score"]:last-child, strong, b');
                if (labelEl && valueEl) {
                    const label = labelEl.textContent.trim();
                    const value = valueEl.textContent.trim();
                    if (label && value && label !== value && /\d/.test(value)) {
                        data.scores[label] = value;
                    }
                }
            });

            // Fallback: grab any element that looks like "Score: 85/100"
            if (Object.keys(data.scores).length === 0) {
                document.querySelectorAll('*').forEach(el => {
                    if (el.children.length > 3) return; // skip containers
                    const text = el.textContent.trim();
                    const match = text.match(/^(.+?)[\s:]+(\d{1,3}(?:\.\d+)?)\s*(?:\/\s*100)?$/);
                    if (match && match[1].length < 50 && parseFloat(match[2]) <= 100) {
                        data.scores[match[1].trim()] = match[2];
                    }
                });
            }

            // ── Pros & Cons ───────────────────────────────────────────────
            // nanoreview typically uses lists with plus/minus or pros/cons classes
            const prosSelectors = ['[class*="pros"] li', '[class*="plus"] li', '[class*="advantage"] li', '.good li', '[class*="pro"] li'];
            const consSelectors = ['[class*="cons"] li', '[class*="minus"] li', '[class*="disadvantage"] li', '.bad li', '[class*="con"] li'];

            prosSelectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    const t = el.textContent.trim();
                    if (t && !data.pros.includes(t)) data.pros.push(t);
                });
            });

            consSelectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    const t = el.textContent.trim();
                    if (t && !data.cons.includes(t)) data.cons.push(t);
                });
            });

            // ── Specs ─────────────────────────────────────────────────────
            // nanoreview uses definition lists (dl/dt/dd) and tables for specs
            // Try dl/dt/dd first
            document.querySelectorAll('dl').forEach(dl => {
                const sectionEl = dl.closest('section, .card, [class*="block"], [class*="section"]');
                const sectionTitle = sectionEl
                    ? (sectionEl.querySelector('h2, h3, h4, [class*="title"]')?.textContent.trim() || 'Specs')
                    : 'Specs';

                if (!data.specs[sectionTitle]) data.specs[sectionTitle] = {};
                const dts = dl.querySelectorAll('dt');
                const dds = dl.querySelectorAll('dd');
                dts.forEach((dt, i) => {
                    const key = dt.textContent.trim().replace(/:$/, '');
                    const val = dds[i]?.textContent.trim() || '';
                    if (key && val) data.specs[sectionTitle][key] = val;
                });
            });

            // Try table rows
            document.querySelectorAll('table').forEach(table => {
                const sectionEl = table.closest('section, .card, [class*="block"], [class*="section"]');
                const sectionTitle = sectionEl
                    ? (sectionEl.querySelector('h2, h3, h4, [class*="title"]')?.textContent.trim() || 'Specs')
                    : 'Specs';

                if (!data.specs[sectionTitle]) data.specs[sectionTitle] = {};
                table.querySelectorAll('tr').forEach(row => {
                    const cells = row.querySelectorAll('td, th');
                    if (cells.length >= 2) {
                        const key = cells[0].textContent.trim().replace(/:$/, '');
                        const val = cells[cells.length - 1].textContent.trim();
                        if (key && val && key !== val) data.specs[sectionTitle][key] = val;
                    }
                });
            });

            // Fallback: grab any key-value pair elements
            if (Object.keys(data.specs).length === 0) {
                const section = {};
                document.querySelectorAll('[class*="spec"], [class*="param"], [class*="feature"]').forEach(el => {
                    const key = el.querySelector('[class*="label"], [class*="name"], [class*="key"]')?.textContent.trim();
                    const val = el.querySelector('[class*="value"], [class*="val"]')?.textContent.trim();
                    if (key && val && key !== val) section[key] = val;
                });
                if (Object.keys(section).length > 0) data.specs['Specifications'] = section;
            }

            return data;
        }, deviceUrl);
    });
}

// ── Compare page scraper ───────────────────────────────────────────────────

async function browserScrapeCompare(compareUrl) {
    return withBrowserPage(compareUrl, ['font', 'media'], async (page) => {
        return await page.evaluate((sourceUrl) => {
            const data = {
                title: document.querySelector('h1')?.textContent.trim() || document.title,
                sourceUrl,
                images: [],
                device1: { name: '', score: '' },
                device2: { name: '', score: '' },
                comparisons: {},
            };

            // Extract device names from headings
            const headings = [...document.querySelectorAll('h2, h3, th, [class*="device-name"], [class*="title"]')]
                .map(el => el.textContent.trim())
                .filter(t => t && t.toLowerCase() !== 'vs' && t.length > 2);
            if (headings.length >= 2) {
                data.device1.name = headings[0];
                data.device2.name = headings[1];
            }

            // Extract comparison rows from tables
            document.querySelectorAll('table, [class*="compare"], [class*="vs"]').forEach(table => {
                const sectionEl = table.closest('section, .card, [class*="block"]');
                const sectionTitle = sectionEl?.querySelector('h2, h3, [class*="title"]')?.textContent.trim() || 'Comparison';
                if (!data.comparisons[sectionTitle]) data.comparisons[sectionTitle] = {};

                table.querySelectorAll('tr, [class*="row"]').forEach(row => {
                    const cells = row.querySelectorAll('td, th, [class*="cell"], [class*="col"]');
                    if (cells.length >= 3) {
                        const feature = cells[0].textContent.trim().replace(/:$/, '');
                        const val1 = cells[1].textContent.trim();
                        const val2 = cells[2].textContent.trim();
                        if (feature) {
                            data.comparisons[sectionTitle][feature] = {
                                [data.device1.name || 'Device 1']: val1,
                                [data.device2.name || 'Device 2']: val2,
                            };
                        }
                    }
                });
            });

            return data;
        }, compareUrl);
    });
}

// ── Ranking page scraper ───────────────────────────────────────────────────

async function browserScrapeRanking(rankingUrl) {
    return withBrowserPage(rankingUrl, ['font', 'media', 'image'], async (page) => {
        return await page.evaluate((sourceUrl) => {
            const data = {
                title: document.querySelector('h1')?.textContent.trim() || document.title,
                sourceUrl,
                rankings: [],
            };

            const headers = [...document.querySelectorAll('table thead th')].map(th => th.textContent.trim());

            document.querySelectorAll('table tbody tr').forEach(row => {
                const item = {};
                row.querySelectorAll('td').forEach((td, i) => {
                    const key = headers[i] ? headers[i].toLowerCase().replace(/\s+/g, '_') : `col_${i}`;
                    item[key] = td.textContent.trim();
                    const a = td.querySelector('a');
                    if (a && !item.url) {
                        const href = a.getAttribute('href');
                        item.url = href?.startsWith('http') ? href : `https://nanoreview.net${href}`;
                    }
                });
                if (Object.keys(item).length > 0) data.rankings.push(item);
            });

            // Fallback: list-based rankings
            if (data.rankings.length === 0) {
                document.querySelectorAll('[class*="item"], [class*="device"], [class*="chip"], li').forEach((el, i) => {
                    const name = el.querySelector('a, [class*="name"], [class*="title"]')?.textContent.trim();
                    const score = el.querySelector('[class*="score"], [class*="rating"], [class*="value"]')?.textContent.trim();
                    const a = el.querySelector('a');
                    const href = a?.getAttribute('href');
                    if (name) {
                        data.rankings.push({
                            rank: String(i + 1),
                            name,
                            score: score || '',
                            url: href ? (href.startsWith('http') ? href : `https://nanoreview.net${href}`) : '',
                        });
                    }
                });
            }

            return data;
        }, rankingUrl);
    });
}

// ── HTML-based scrapers (for worker cache warming via direct HTTP) ──────────

export const scrapeDeviceHtml = (html, deviceUrl) => {
    const $ = cheerio.load(html);
    const data = { title: $('h1').text().trim() || $('title').text().trim(), sourceUrl: deviceUrl, images: [], scores: {}, pros: [], cons: [], specs: {} };

    $('img').each((_, img) => {
        const srcs = [$(img).attr('src'), $(img).attr('data-src')];
        srcs.forEach(src => {
            if (!src) return;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            if (src.startsWith('http') && !/(logo|icon|avatar|svg|sprite)/i.test(src)) data.images.push(src);
        });
    });
    data.images = [...new Set(data.images)];

    $('dt').each((_, dt) => {
        const key = $(dt).text().trim().replace(/:$/, '');
        const val = $(dt).next('dd').text().trim();
        if (key && val) { if (!data.specs['Specs']) data.specs['Specs'] = {}; data.specs['Specs'][key] = val; }
    });

    return data;
};

export const scrapeRankingHtml = (html, rankingUrl) => {
    const $ = cheerio.load(html);
    const data = { title: $('h1').text().trim(), sourceUrl: rankingUrl, rankings: [] };
    const headers = [];
    $('table thead th').each((_, th) => headers.push($(th).text().trim()));
    $('table tbody tr').each((_, row) => {
        const item = {};
        $(row).find('td').each((i, td) => {
            const key = headers[i] ? headers[i].toLowerCase().replace(/\s+/g, '_') : `col_${i}`;
            item[key] = $(td).text().trim();
            const a = $(td).find('a').attr('href');
            if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
        });
        if (Object.keys(item).length > 0) data.rankings.push(item);
    });
    return data;
};

// ── Public API ─────────────────────────────────────────────────────────────

export const searchDevices = async (query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);

    // Fast path: direct HTTP JSON API (no browser)
    let results;
    try {
        results = await directSearch(query, limit, types);
    } catch {
        results = null;
    }

    // Browser fallback
    if (!results || results.length === 0) {
        const { browser, context } = await getBrowserContext();
        try {
            const page = await context.newPage();
            try {
                await page.route('**/*', r => ['font','media','image','stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue());
                await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });
                await waitForCloudflare(page, 'body', 12000).catch(() => {});

                results = await page.evaluate(async ({ query, limit, types }) => {
                    const all = await Promise.all(types.map(async type => {
                        try {
                            const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                            const r = await fetch(url, { headers: { Accept: 'application/json' } });
                            if (!r.ok) return [];
                            const d = await r.json();
                            return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
                        } catch { return []; }
                    }));
                    return all.flat();
                }, { query, limit, types });
            } finally {
                await page.close().catch(() => {});
            }
        } finally {
            await browser.close().catch(() => {});
        }
    }

    if (!results || results.length === 0) return [];
    results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    cache.set('search', cacheKey, results, TTL.search);
    return results;
};

export const scrapeDevicePage = async (deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;

    // Always use browser for device pages (Cloudflare blocks direct HTTP)
    const data = await browserScrapeDevice(deviceUrl);
    cache.set('device', deviceUrl, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;

    const data = await browserScrapeCompare(compareUrl);
    cache.set('compare', compareUrl, data, TTL.compare);
    return data;
};

export const scrapeRankingPage = async (rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;

    const data = await browserScrapeRanking(rankingUrl);
    cache.set('ranking', rankingUrl, data, TTL.ranking);
    return data;
};
