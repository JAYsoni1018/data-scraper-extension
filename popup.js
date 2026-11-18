const $ = (id) => document.getElementById(id);

const send = (tabId, msg) =>
    new Promise((res) =>
        chrome.tabs.sendMessage(tabId, msg, (r) => res(chrome.runtime.lastError ? null : r)));

async function ensureInjected(tab) {
    if (await send(tab.id, { type: 'PING' })) return;
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['xlsx.full.min.js', 'content.js'],
    });
}

let tab;
(async () => {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
        await ensureInjected(tab);
    } catch {
        $('status').textContent = 'Cannot run on this page (browser/store pages are blocked).';
        return;
    }
    const res = await send(tab.id, { type: 'LIST' });
    const sel = $('table');
    (res?.tables || []).forEach((t) => sel.add(new Option(t.label, t.i)));
    if (!sel.options.length) sel.add(new Option('No tables found', ''));
})();

$('go').addEventListener('click', async () => {
    if ($('table').value === '') return;
    $('status').textContent = 'Working... keep this tab open.';
    const res = await send(tab.id, {
        type: 'EXPORT',
        idx: Number($('table').value),
        format: $('format').value,
        mode: $('mode').value,
        nextSel: $('nextSel').value.trim(),
        numbers: $('numbers').checked,
        maxPages: Number($('maxPages').value) || 0, // 0 = all pages
    });
    $('status').textContent = res?.ok ? `Done: ${res.count} rows`
        : `Error: ${res?.error || 'no response, reload the page'}`;
});