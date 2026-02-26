/**
 * scraper.js - Maximum speed nanoreview scraper
 *
 * FETCH PRIORITY (fastest → slowest):
 * 1. Memory cache                  → <1ms
 * 2. Next.js /_next/data/ JSON API → ~150-300ms  ← NEW: pure JSON, no parsing
 * 3. Direct HTTP + CF cookies      → ~300-500ms
 * 4. Browser fallback              → ~2-4s (only on cold start / CF block)
 *
 * PIPELINE: search + page fetch overlap — device fetch starts the instant
 * we have a slug from the top-2 type search.
 */
import * as cheerio from 'cheerio';
import { getCFCookies, browserFetchDirect, browserSearchDirect } from './browser.js';
import { cache, TTL } from './cache.js';
import { directSearch, directFetchHtml } from './http.js';
import { fetchNextData } from './nextjs.js';

const detectTypes = (query) => {
    const q = query.toLowerCase();
    if (/ryzen|intel|core i[3579]|threadripper|xeon|celeron|pentium/i.test(q))   return { top: ['cpu','laptop'],  rest: ['soc','phone','tablet','gpu'] };
    if (/snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic|helio/i.test(q)) return { top: ['soc','phone'],   rest: ['tablet','laptop','cpu','gpu'] };
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|arc\s*a[0-9]/i.test(q))       return { top: ['gpu','laptop'],  rest: ['cpu','phone','tablet','soc'] };
    if (/iphone|galaxy\s*s|pixel\s*[0-9]|oneplus|xiaomi|redmi|poco|realme/i.test(q)) return { top: ['phone','soc'], rest: ['tablet','laptop','cpu','gpu'] };
    if (/ipad|galaxy\s*tab|surface\s*pro|tab\s*s[0-9]/i.test(q))                 return { top: ['tablet','phone'], rest: ['soc','laptop','cpu','gpu'] };
    if (/macbook|thinkpad|xps|zenbook|vivobook|chromebook|ultrabook/i.test(q))    return { top: ['laptop','cpu'],  rest: ['gpu','tablet','phone','soc'] };
    return { top: ['phone','laptop'], rest: ['tablet','soc','cpu','gpu'] };
};

function score(name, slug, q) {
    const n = name.toLowerCase(), s = (slug||'').toLowerCase(), ql = q.toLowerCase();
    const qs = ql.replace(/\s+/g,'-');
    if (s===ql||s===qs) return 1000; if (n===ql) return 900;
    if (s.includes(qs)) return 700;  if (n.includes(ql)) return 500;
    let sc = 0; for (const w of ql.split(/\s+/)) if (n.includes(w)) sc+=10;
    return sc - n.length*0.1;
}

export function pickBestMatch(results, query) {
    const q = query.toLowerCase().trim(), qs = q.replace(/\s+/g,'-');
    return results.find(r=>r.slug===q) || results.find(r=>r.slug===qs) ||
           results.find(r=>r.name?.toLowerCase()===q) ||
           results.find(r=>r.slug?.includes(qs)) ||
           results.find(r=>r.name?.toLowerCase().includes(q)) ||
           results.find(r=>q.split(/\s+/).every(w=>r.name?.toLowerCase().includes(w))) ||
           results[0];
}

function dedupe(results, query) {
    const seen = new Set();
    return results
        .filter(r => { const k=r.slug||r.url_name||r.url||r.id||r.name; if(seen.has(k))return false; seen.add(k); return true; })
        .sort((a,b) => score(b.name, b.slug||b.url_name||'', query) - score(a.name, a.slug||a.url_name||'', query));
}

function getSlug(item) {
    return item.slug || item.url_name ||
        item.name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
}

function deviceUrl(item) {
    if (item.url?.startsWith('http')) return item.url;
    if (item.url) return `https://nanoreview.net${item.url}`;
    return `https://nanoreview.net/en/${item.content_type}/${getSlug(item)}`;
}

function fmtResults(deduped) {
    return deduped.map((r,i) => ({ index:i, name:r.name, type:r.content_type, slug:getSlug(r) }));
}

async function tryDirectSearch(query, limit, types, cookies) {
    try {
        const r = await directSearch(query, limit, types, cookies);
        return r.length ? r : null;
    } catch { return null; }
}

async function fetchDeviceData(item, cookies) {
    const slug = getSlug(item);
    const type = item.content_type;
    const url = deviceUrl(item);

    // 1. Try Next.js JSON API first (fastest — pure JSON, no HTML parse)
    const nextData = await fetchNextData(type, slug, cookies);
    if (nextData) return nextData;

    // 2. Direct HTTP with CF cookies
    try {
        const html = await directFetchHtml(url, cookies, 6000);
        if (html) return parseDeviceHtml(html, url);
    } catch {}

    // 3. Browser fallback
    const html = await browserFetchDirect(url);
    return parseDeviceHtml(html, url);
}

export const searchAndFetch = async (query, limit = 10) => {
    const cacheKey = `full:${query.toLowerCase()}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    const cookies = await getCFCookies() || '';
    const { top, rest } = detectTypes(query);
    const allTypes = [...top, ...rest];

    // Fire top-2 and all-types in parallel
    const topPromise  = tryDirectSearch(query, limit, top, cookies);
    const allPromise  = tryDirectSearch(query, limit, allTypes, cookies);

    // As soon as top-2 lands, start fetching device data immediately
    let earlyFetchPromise = null;
    let earlyItem = null;

    const topResults = await topPromise;
    if (topResults?.length) {
        const d = dedupe(topResults, query);
        earlyItem = pickBestMatch(d, query);
        const earlyUrl = deviceUrl(earlyItem);
        const devCached = cache.get('device', earlyUrl);
        if (devCached) {
            // Cache hit on early result — done immediately
            devCached.searchResults = fmtResults(d);
            devCached.matchedDevice = earlyItem.name;
            return devCached;
        }
        console.log(`[pipeline] top-2 hit → pre-fetching ${earlyItem.name}`);
        earlyFetchPromise = fetchDeviceData(earlyItem, cookies);
    }

    // Get full results for better ranking
    const allResults = await allPromise;

    // If all direct HTTP failed, fall back to browser search
    const merged = dedupe([...(allResults||[]), ...(topResults||[])], query);
    let finalItem;

    if (!merged.length) {
        console.log('[pipeline] Direct search failed, browser fallback...');
        const bResults = await browserSearchDirect(query, limit, allTypes);
        if (!bResults?.length) return null;
        const bDeduped = dedupe(bResults, query);
        finalItem = pickBestMatch(bDeduped, query);
        const bUrl = deviceUrl(finalItem);
        const bCached = cache.get('device', bUrl);
        if (bCached) { bCached.searchResults=fmtResults(bDeduped); bCached.matchedDevice=finalItem.name; return bCached; }
        const bHtml = await browserFetchDirect(bUrl);
        const bData = parseDeviceHtml(bHtml, bUrl);
        bData.searchResults=fmtResults(bDeduped); bData.matchedDevice=finalItem.name;
        cache.set('device', bUrl, bData, TTL.device);
        cache.set('device', cacheKey, bData, TTL.device);
        return bData;
    }

    finalItem = pickBestMatch(merged, query);
    const finalUrl = deviceUrl(finalItem);
    console.log(`[pipeline] final: ${finalItem.name} → ${finalUrl}`);

    // Cache check with final item
    const finalCached = cache.get('device', finalUrl);
    if (finalCached) {
        finalCached.searchResults=fmtResults(merged); finalCached.matchedDevice=finalItem.name;
        return finalCached;
    }

    // Reuse early fetch if it matches final item, else start fresh
    let data;
    if (earlyFetchPromise && earlyItem && deviceUrl(earlyItem) === finalUrl) {
        data = await earlyFetchPromise;
    } else {
        data = await fetchDeviceData(finalItem, cookies);
    }

    data.searchResults = fmtResults(merged);
    data.matchedDevice = finalItem.name;
    cache.set('device', finalUrl, data, TTL.device);
    cache.set('device', cacheKey, data, TTL.device);
    return data;
};

function parseDeviceHtml(html, url) {
    // Fast regex path — no DOM load needed
    try {
        const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
        if (m) {
            const next = JSON.parse(m[1]);
            const props = next?.props?.pageProps;
            const d = props?.device||props?.phone||props?.item||props?.data||props?.pageData;
            if (d?.name) return {
                title:d.name, sourceUrl:url,
                images: d.image?[d.image]:(d.images||[]),
                scores: d.scores||d.ratings||{},
                pros:   d.pros||d.advantages||[],
                cons:   d.cons||d.disadvantages||[],
                specs:  d.specs||d.specifications||d.params||{},
                _source:'next_data',
            };
        }
    } catch {}

    // Full DOM parse fallback
    const $ = cheerio.load(html);
    const data = { title:$('h1').first().text().trim(), sourceUrl:url, images:[], scores:{}, pros:[], cons:[], specs:{} };
    const seen = new Set();
    $('img').each((_,img) => {
        [$(img).attr('data-src'), $(img).attr('src')].forEach(src => {
            if (!src) return;
            if (src.startsWith('/')) src=`https://nanoreview.net${src}`;
            if (src.startsWith('http') && !/(logo|icon|avatar|svg)/i.test(src) && !seen.has(src)) { seen.add(src); data.images.push(src); }
        });
    });
    $('[class*="score"],.progress-bar,.rating-box').each((_,el) => {
        const label=$(el).find('[class*="title"],[class*="name"]').first().text().trim()||$(el).prev().text().trim();
        const value=$(el).find('[class*="value"],[class*="num"]').first().text().trim()||$(el).text().replace(/[^0-9]/g,'').trim();
        if (label&&value&&label!==value) data.scores[label]=value;
    });
    $('[class*="pros"] li,[class*="plus"] li,.green li').each((_,el)=>{ const t=$(el).text().trim(); if(t) data.pros.push(t); });
    $('[class*="cons"] li,[class*="minus"] li,.red li').each((_,el)=>{ const t=$(el).text().trim(); if(t) data.cons.push(t); });
    $('.card,.box,section,[class*="specs"]').each((_,card)=>{
        const sTitle=$(card).find('.card-header,.card-title,h2,h3').first().text().trim()||'Details';
        const section={};
        $(card).find('table tr').each((__,row)=>{
            const cells=$(row).find('td,th');
            if(cells.length>=2){ const l=cells.first().text().trim().replace(/:$/,''); const v=cells.last().text().trim(); if(l&&v&&l!==v) section[l]=v; }
        });
        if(Object.keys(section).length>0) data.specs[sTitle]=section;
    });
    return data;
}

// ── Other exports ──────────────────────────────────────────────────────────

export const searchDevices = async (query, limit = 10) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;
    const cookies = await getCFCookies() || '';
    const { top, rest } = detectTypes(query);
    let results = await tryDirectSearch(query, limit, [...top,...rest], cookies);
    if (!results?.length) results = await browserSearchDirect(query, limit, [...top,...rest]);
    const deduped = dedupe(results||[], query);
    cache.set('search', cacheKey, deduped, TTL.search);
    return deduped;
};

export const scrapeDevicePage = async (url) => {
    const cached = cache.get('device', url);
    if (cached) return cached;
    const cookies = await getCFCookies() || '';
    // Extract type/slug from URL for Next.js API attempt
    const m = url.match(/nanoreview\.net\/en\/([^/]+)\/([^/?]+)/);
    let data = null;
    if (m) data = await fetchNextData(m[1], m[2], cookies);
    if (!data) {
        try { const html=await directFetchHtml(url,cookies,6000); if(html) data=parseDeviceHtml(html,url); } catch {}
    }
    if (!data) { const html=await browserFetchDirect(url); data=parseDeviceHtml(html,url); }
    cache.set('device', url, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;
    const cookies = await getCFCookies() || '';
    let html;
    try { html=await directFetchHtml(compareUrl,cookies,6000); } catch {}
    if (!html) html=await browserFetchDirect(compareUrl);
    const $=cheerio.load(html);
    const data={title:$('h1').first().text().trim(),sourceUrl:compareUrl,device1:{name:''},device2:{name:''},comparisons:{}};
    const headers=[];
    $('th,[class*="title"]').each((_,el)=>{ const t=$(el).text().trim(); if(t&&t.toLowerCase()!=='vs') headers.push(t); });
    if(headers.length>=2){data.device1.name=headers[0];data.device2.name=headers[1];}
    $('.card,.box,section,[class*="specs"]').each((_,card)=>{
        const sTitle=$(card).find('h2,h3').first().text().trim()||'Comparison'; const section={};
        $(card).find('table tr').each((__,row)=>{
            const cells=$(row).find('td,th'); if(cells.length>=3){
                const f=cells.eq(0).text().trim().replace(/:$/,'');
                const v1=cells.eq(1).text().trim(), v2=cells.eq(2).text().trim();
                if(f) section[f]={[data.device1.name||'Device 1']:v1,[data.device2.name||'Device 2']:v2};
            }
        });
        if(Object.keys(section).length>0) data.comparisons[sTitle]=section;
    });
    cache.set('compare', compareUrl, data, TTL.compare);
    return data;
};

export const scrapeRankingPage = async (rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;
    const cookies = await getCFCookies() || '';
    let html;
    try { html=await directFetchHtml(rankingUrl,cookies,6000); } catch {}
    if (!html) html=await browserFetchDirect(rankingUrl);
    const $=cheerio.load(html);
    const data={title:$('h1').first().text().trim(),sourceUrl:rankingUrl,rankings:[]};
    const headers=[];
    $('table thead th').each((_,th)=>headers.push($(th).text().trim()));
    $('table tbody tr').each((_,row)=>{
        const item={};
        $(row).find('td').each((i,td)=>{
            item[headers[i]?.toLowerCase().replace(/\s+/g,'_')||`col_${i}`]=$(td).text().trim();
            const a=$(td).find('a').attr('href'); if(a&&!item.url) item.url=a.startsWith('http')?a:`https://nanoreview.net${a}`;
        });
        if(Object.keys(item).length>0) data.rankings.push(item);
    });
    cache.set('ranking', rankingUrl, data, TTL.ranking);
    return data;
};

export const scrapeDeviceHtml = parseDeviceHtml;
export const scrapeRankingHtml = (html,url) => {
    const $=cheerio.load(html);
    const data={title:$('h1').first().text().trim(),sourceUrl:url,rankings:[]};
    const headers=[];
    $('table thead th').each((_,th)=>headers.push($(th).text().trim()));
    $('table tbody tr').each((_,row)=>{
        const item={}; $(row).find('td').each((i,td)=>{ item[headers[i]?.toLowerCase().replace(/\s+/g,'_')||`col_${i}`]=$(td).text().trim(); });
        if(Object.keys(item).length>0) data.rankings.push(item);
    });
    return data;
};
