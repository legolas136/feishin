import { ipcMain } from 'electron';

import log from '/@/main/logger';

const TIMEOUT_MS = 10000;

// Reads the current ICY StreamTitle of a radio stream. Done here rather than in the renderer
// because most stations' CORS headers block the Icy-MetaData request or hide icy-metaint
// from a page, which made the renderer silently show no titles.
async function getIcyStreamTitle(url: string): Promise<null | string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { 'Icy-MetaData': '1' },
            signal: controller.signal,
        });
        const metaint = Number(res.headers.get('icy-metaint'));
        if (!res.ok || !res.body || !(metaint > 0)) return null;

        // The stream is metaint audio bytes, one length byte (x16), then the metadata block.
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        let data = new Uint8Array(0);
        while (true) {
            const { done, value } = await reader.read();
            if (done) return null;
            chunks.push(value);
            size += value.length;
            if (size <= metaint) continue;
            data = Buffer.concat(chunks);
            if (data.length >= metaint + 1 + data[metaint] * 16) break;
        }
        const block = Buffer.from(data.subarray(metaint + 1, metaint + 1 + data[metaint] * 16));
        let text = block.toString('utf8');
        if (text.includes('�')) text = block.toString('latin1'); // older Shoutcast servers
        return /StreamTitle='(.*?)';/s.exec(text)?.[1].trim() || null;
    } catch (err) {
        if (!controller.signal.aborted)
            log.debug(`[Radio] Failed to read ICY metadata: ${(err as Error).message}`);
        return null;
    } finally {
        clearTimeout(timer);
        controller.abort(); // closes the stream connection
    }
}

ipcMain.handle('radio-get-stream-title', (_event, url: string) => getIcyStreamTitle(url));
