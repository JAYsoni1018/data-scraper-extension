const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/\s+/g, ' ').trim();

function findTable() {
    // the screener table is the one with the most rows
    return [...document.querySelectorAll('table')]
        .sort((a, b) => b.rows.length - a.rows.length)[0];
}


function findNextByEntries() {
    const label = [...document.querySelectorAll('div,span,p')]
        .find((e) => e.children.length === 0 && /\d[\d,]*\s*entries/i.test(e.textContent));
    if (!label) return null;
    let box = label.parentElement;
    for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
        const items = [...box.querySelectorAll('a,button,li,[role="button"]')]
            .filter((e) => !e.contains(label));
        if (items.length >= 3) return items[items.length - 1];
    }
    return null;
}

function findNext(custom) {
    if (custom) return document.querySelector(custom);
    const txt = (e) => (e.getAttribute('aria-label') || e.title || e.textContent || '').trim();
    const clickable = [...document.querySelectorAll('a,button,[role="button"]')];
    return (
        document.querySelector('a[rel="next"]') ||
        clickable.find((e) => /^(next|next page|›|»|>|→)$/i.test(txt(e))) ||
        findNextByEntries() ||
        document.querySelector('[class*="next" i]:not([class*="prev" i])')
    );
}

const isDisabled = (el) =>
    !el || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
    /disabled/i.test((el.className || '') + (el.parentElement?.className || ''));

async function waitForChange(idx, prevFirstRow) {
    for (let i = 0; i < 40; i++) {
        await sleep(250);
        let first;
        try { first = scrapePage(idx).rows[0]?.join('|'); } catch { first = undefined; }
        if (first && first !== prevFirstRow) return true;
    }
    return false;
}


function getTables(doc = document) {
    const real = [...doc.querySelectorAll('table')].filter((t) => t.rows.length > 1);
    const aria = [...doc.querySelectorAll('[role="table"],[role="grid"]')]
        .filter((g) => g.querySelectorAll('[role="row"]').length > 1);
    return [...real, ...aria];
}


function describe(el, i) {
    const isTable = el.matches('table');
    const n = isTable ? el.rows.length : el.querySelectorAll('[role="row"]').length;
    const hint = clean((el.querySelector('th,[role="columnheader"]') || el).textContent).slice(0, 25);
    return { i, label: `#${i + 1} · ${n} rows · ${hint}` };
}


function scrapePage(idx, doc = document) {
    const el = getTables(doc)[idx];
    if (!el) throw new Error('Table not found');
    const isTable = el.matches('table');

    const rowEls = isTable ? [...el.rows] : [...el.querySelectorAll('[role="row"]')];
    const cellsOf = (r) =>
        (isTable ? [...r.children]
            : [...r.querySelectorAll('[role="columnheader"],[role="rowheader"],[role="gridcell"],[role="cell"]')])
            .map((c) => clean(c.innerText || c.textContent));
    const isHead = (r) => isTable
        ? r.parentElement.tagName === 'THEAD' || !r.querySelector('td')
        : !r.querySelector('[role="gridcell"],[role="cell"]');

    const headRow = rowEls.filter(isHead).pop();
    return {
        headers: headRow ? cellsOf(headRow) : [],
        rows: rowEls.filter((r) => !isHead(r)).map(cellsOf).filter((r) => r.length > 1),
    };
}
async function scrapeAll({ idx, mode, nextSel, maxPages }) {
    const { headers, rows: firstRows } = scrapePage(idx);
    const seen = new Set();
    const out = [];
    const add = (rows) => {
        let added = 0;
        for (const r of rows) {
            const k = r.join('|');
            if (!seen.has(k)) { seen.add(k); out.push(r); added++; }
        }
        return added;
    };
    add(firstRows);

    if (mode === 'next') {
        for (let p = 1; p < (maxPages || 200); p++) {
            const next = findNext(nextSel);
            if (isDisabled(next)) break;
            const prev = scrapePage(idx).rows[0]?.join('|');
            next.click();
            if (!(await waitForChange(idx, prev))) break;
            if (add(scrapePage(idx).rows) === 0) break;
        }
    } else if (mode === 'scroll') {
        let idle = 0;
        while (idle < 3) {
            let box = getTables()[idx];
            while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
            (box || document.documentElement).scrollTo(0, (box || document.documentElement).scrollHeight);
            await sleep(1000);
            idle = add(scrapePage(idx).rows) ? 0 : idle + 1;
        }
    } else if (mode === 'url') {
        const links = [...document.querySelectorAll(nextSel || 'button.page-option.arrow a')];
        const a = links.find((x) => x.textContent.trim() === '›' && x.getAttribute('href'))
            || links.filter((x) => x.getAttribute('href')).pop();
        if (!a) throw new Error('Next link not found (are you on the last page?)');

        const nextUrl = new URL(a.href, location.href);
        const curUrl = new URL(location.href);
        let key = null;                                   // the param that changes, e.g. pageNumber
        for (const [k, v] of nextUrl.searchParams) {
            if (curUrl.searchParams.get(k) !== v) key = k;
        }
        if (!key) throw new Error('Could not detect the page parameter');

        let page = Number(nextUrl.searchParams.get(key));
        for (let n = 1; n < (maxPages || 500); n++, page++) {
            nextUrl.searchParams.set(key, page);
            const res = await fetch(nextUrl.href, { credentials: 'include' });
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            let rows = [];
            try { rows = scrapePage(idx, doc).rows; } catch { }
            if (n === 1 && !rows.length) {
                throw new Error('Fetched page has no table (site renders it with JavaScript)');
            }
            if (!add(rows)) break;                          // past the last page: nothing new
            await sleep(300);                               // be polite to the server
        }
    }
    return { headers, rows: out };
}
// "2,54,299" -> 254299 ; "6.01%" -> 6.01 ; text stays text
const toNum = (v) => {
    if (!/^-?\d[\d,]*\.?\d*%?$/.test(v) || /^0\d/.test(v)) return v;
    return Number(v.replace(/[,%]/g, ''));
};

function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function saveCSV(headers, rows, name) {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = '\ufeff' + [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name + '.csv');
}

function saveXLSX(headers, rows, name) {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stocks');
    XLSX.writeFile(wb, name + '.xlsx');
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse(true); return; }
    if (msg.type === 'LIST') { sendResponse({ tables: getTables().map(describe) }); return; }
    if (msg.type !== 'EXPORT') return;

    (async () => {
        const { headers, rows } = await scrapeAll(msg);
        const data = msg.numbers ? rows.map((r) => r.map(toNum)) : rows;
        const name = `${location.hostname}_${new Date().toISOString().slice(0, 10)}`;
        msg.format === 'xlsx' ? saveXLSX(headers, data, name) : saveCSV(headers, data, name);
        sendResponse({ ok: true, count: data.length });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));

    return true;
});