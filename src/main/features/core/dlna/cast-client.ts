// Google Cast (Chromecast) transport for the cast target. Devices are found over mDNS and
// driven through the Default Media Receiver: the device fetches the stream URL itself, just
// like a DLNA renderer. No dependencies: the CastMessage protobuf has six fields, so it is
// encoded by hand, and discovery is a single legacy-unicast mDNS query.
import dgram from 'dgram';
import { EventEmitter } from 'events';
import os from 'os';
import tls from 'tls';

import log from '/@/main/logger';

export interface CastDeviceInfo {
    host: string;
    id: string;
    isGroup: boolean;
    model: string;
    name: string;
    port: number;
}

export interface CastGroupMember {
    deviceId: string;
    name: string;
    volume: { level: number; muted: boolean };
}

export interface CastMediaStatus {
    currentItemId?: number;
    currentTime: number;
    duration: number;
    idleReason?: string;
    // Queue item ids, present when the device includes the queue in the status.
    itemIds?: number[];
    mediaSessionId: number;
    playerState: 'BUFFERING' | 'IDLE' | 'PAUSED' | 'PLAYING';
}

const castLog = (action: string, err?: unknown) => log.info(`[Cast] ${action}`, err);

// --- Discovery -------------------------------------------------------------------------------

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_googlecast._tcp.local';

interface DnsRecords {
    a: Map<string, string>;
    srv: Map<string, { port: number; target: string }>;
    txt: Map<string, Record<string, string>>;
}

// Queries from an ephemeral port get unicast answers (RFC 6762 6.7), so this never has to
// share port 5353 with the OS's own mDNS responder.
export async function discoverCastDevices(timeout = 3000): Promise<CastDeviceInfo[]> {
    const records: DnsRecords = { a: new Map(), srv: new Map(), txt: new Map() };
    const query = Buffer.concat([
        Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
        encodeName(SERVICE),
        Buffer.from([0, 12, 0, 1]),
    ]);
    const sockets = localIpv4Addresses().map((address) => {
        const socket = dgram.createSocket('udp4');
        socket.on('error', (err) => castLog(`mDNS socket error on ${address}`, err));
        socket.on('message', (msg) => {
            try {
                parseResponse(msg, records);
            } catch (err) {
                castLog('Ignoring malformed mDNS response', err);
            }
        });
        socket.bind(0, address, () => {
            const send = () => socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => {});
            try {
                socket.setMulticastInterface(address);
            } catch {
                // Not fatal: the default interface is used
            }
            send();
            setTimeout(send, 1000);
        });
        return socket;
    });
    await new Promise((r) => setTimeout(r, timeout));
    sockets.forEach((s) => s.close());

    const devices: CastDeviceInfo[] = [];
    for (const [instance, srv] of records.srv) {
        if (!instance.endsWith(SERVICE)) continue;
        const txt = records.txt.get(instance) ?? {};
        const host = records.a.get(srv.target);
        if (!host) continue;
        devices.push({
            host,
            id: txt.id || instance,
            isGroup: txt.md === 'Google Cast Group',
            model: txt.md || 'Chromecast',
            name: txt.fn || instance.split('.')[0],
            port: srv.port,
        });
    }
    return devices.sort((a, b) => a.name.localeCompare(b.name));
}

function decodeMessage(buf: Buffer): { namespace: string; payload: string; source: string } {
    const fields: Record<number, string> = {};
    let off = 0;
    const readVarint = () => {
        let result = 0;
        let shift = 0;
        while (true) {
            const b = buf[off++];
            result += (b & 0x7f) * 2 ** shift;
            if (b < 0x80) return result;
            shift += 7;
        }
    };
    while (off < buf.length) {
        const key = readVarint();
        if ((key & 7) === 0) {
            readVarint();
        } else {
            const len = readVarint();
            fields[key >>> 3] = buf.toString('utf8', off, off + len);
            off += len;
        }
    }
    return { namespace: fields[4] ?? '', payload: fields[6] ?? '', source: fields[2] ?? '' };
}

function encodeMessage(source: string, destination: string, ns: string, payload: string) {
    const body = Buffer.concat([
        Buffer.from([0x08, 0]), // protocol_version CASTV2_1_0
        stringField(0x12, source),
        stringField(0x1a, destination),
        stringField(0x22, ns),
        Buffer.from([0x28, 0]), // payload_type STRING
        stringField(0x32, payload),
    ]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
}

function encodeName(name: string): Buffer {
    const labels = name
        .split('.')
        .map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
    return Buffer.concat([...labels, Buffer.from([0])]);
}

function localIpv4Addresses(): string[] {
    return Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal)
        .map((i) => i!.address);
}

// --- CastMessage framing ---------------------------------------------------------------------

function mediaInfo(options: CastLoadOptions) {
    return {
        contentId: options.url,
        contentType: options.contentType,
        duration: options.duration,
        metadata: {
            albumName: options.albumName,
            artist: options.artistName,
            images: options.albumArtUrl ? [{ url: options.albumArtUrl }] : [],
            metadataType: 3, // MusicTrackMediaMetadata
            title: options.title,
        },
        streamType: options.live ? 'LIVE' : 'BUFFERED',
    };
}

function parseResponse(buf: Buffer, into: DnsRecords) {
    let off = 12;
    const questions = buf.readUInt16BE(4);
    const records = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    for (let i = 0; i < questions; i++) off = readName(buf, off).end + 4;
    for (let i = 0; i < records; i++) {
        const { end, name } = readName(buf, off);
        const type = buf.readUInt16BE(end);
        const len = buf.readUInt16BE(end + 8);
        const data = end + 10;
        if (type === 1) {
            into.a.set(name, [...buf.subarray(data, data + 4)].join('.'));
        } else if (type === 33) {
            into.srv.set(name, {
                port: buf.readUInt16BE(data + 4),
                target: readName(buf, data + 6).name,
            });
        } else if (type === 16) {
            const txt: Record<string, string> = {};
            for (let p = data; p < data + len; p += buf[p] + 1) {
                const entry = buf.toString('utf8', p + 1, p + 1 + buf[p]);
                const eq = entry.indexOf('=');
                if (eq > 0) txt[entry.slice(0, eq)] = entry.slice(eq + 1);
            }
            into.txt.set(name, txt);
        }
        off = data + len;
    }
}

function readName(buf: Buffer, start: number): { end: number; name: string } {
    const labels: string[] = [];
    let off = start;
    let end = -1;
    for (let hops = 0; hops < 64; hops++) {
        const len = buf[off];
        if (len === 0) {
            off += 1;
            break;
        }
        if ((len & 0xc0) === 0xc0) {
            if (end < 0) end = off + 2;
            off = ((len & 0x3f) << 8) | buf[off + 1];
            continue;
        }
        labels.push(buf.toString('utf8', off + 1, off + 1 + len));
        off += len + 1;
    }
    return { end: end < 0 ? off : end, name: labels.join('.') };
}

function replyError(reply: any) {
    return new Error(`${reply.type}${reply.reason ? `: ${reply.reason}` : ''}`);
}

function stringField(tag: number, value: string): Buffer {
    const data = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([tag]), varint(data.length), data]);
}

function varint(n: number): Buffer {
    const bytes: number[] = [];
    while (n > 0x7f) {
        bytes.push((n & 0x7f) | 0x80);
        n >>>= 7;
    }
    bytes.push(n);
    return Buffer.from(bytes);
}

// --- Session ---------------------------------------------------------------------------------

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';
const NS_MULTIZONE = 'urn:x-cast:com.google.cast.multizone';
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';
const SENDER = 'sender-feishin';
const RECEIVER = 'receiver-0';

export interface CastLoadOptions {
    albumArtUrl?: string;
    albumName?: string;
    artistName?: string;
    autoplay: boolean;
    contentType: string;
    currentTime: number;
    duration?: number;
    live?: boolean;
    title: string;
    url: string;
}

/**
 * One connection to one cast device (or cast group). Emits `media` (CastMediaStatus),
 * `volume` ({ level, muted }, 0-1), `member-volume` (CastGroupMember, cast groups only),
 * `app-closed` and `close`.
 */
export class CastSession extends EventEmitter {
    mediaSessionId = 0;
    private appSessionId = '';
    private buffer = Buffer.alloc(0);
    private heartbeat: NodeJS.Timeout | null = null;
    private pending = new Map<number, (msg: any) => void>();
    private requestId = 1;
    private socket: null | tls.TLSSocket = null;
    private transportId = '';

    constructor(private readonly device: CastDeviceInfo) {
        super();
    }

    // Joins a Default Media Receiver session already running on the device (left playing by
    // an earlier passive disconnect, or another sender). Resolves to its media status.
    async attach(receiverStatus: any): Promise<any> {
        const app = receiverStatus?.applications?.find(
            (a: any) => a.appId === DEFAULT_MEDIA_RECEIVER,
        );
        if (!app) return null;
        this.transportId = app.transportId;
        this.appSessionId = app.sessionId;
        this.send(this.transportId, NS_CONNECTION, { type: 'CONNECT' });
        const reply = await this.request(this.transportId, NS_MEDIA, { type: 'GET_STATUS' });
        return reply.status?.[0] ?? null;
    }

    close() {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.socket?.destroy();
        this.socket = null;
    }

    async connect(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const socket = tls.connect({
                host: this.device.host,
                port: this.device.port,
                // Cast devices present a certificate signed by Google's device CA, not a
                // public one; there is no host name to verify against on a LAN address.
                rejectUnauthorized: false,
            });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('Connection timed out'));
            }, 5000);
            socket.once('secureConnect', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            socket.on('data', (chunk) => this.onData(chunk));
            socket.on('close', () => {
                if (this.socket === socket) {
                    this.close();
                    this.emit('close');
                }
            });
            this.socket = socket;
        });
        this.send(RECEIVER, NS_CONNECTION, { type: 'CONNECT' });
        this.heartbeat = setInterval(
            () => this.send(RECEIVER, NS_HEARTBEAT, { type: 'PING' }),
            5000,
        );
    }

    // Members of a cast group with their own volume. Empty for a single device.
    async getGroupMembers(): Promise<CastGroupMember[]> {
        const reply = await this.request(RECEIVER, NS_MULTIZONE, { type: 'GET_STATUS' });
        return reply.status?.devices ?? [];
    }

    async getReceiverStatus(): Promise<any> {
        return (await this.request(RECEIVER, NS_RECEIVER, { type: 'GET_STATUS' })).status;
    }

    async launch(): Promise<void> {
        const status = await this.request(RECEIVER, NS_RECEIVER, {
            appId: DEFAULT_MEDIA_RECEIVER,
            type: 'LAUNCH',
        });
        const app = status.status?.applications?.find(
            (a: any) => a.appId === DEFAULT_MEDIA_RECEIVER,
        );
        if (!app) throw new Error(`Launch failed: ${JSON.stringify(status)}`);
        this.transportId = app.transportId;
        this.appSessionId = app.sessionId;
        this.mediaSessionId = 0;
        this.send(this.transportId, NS_CONNECTION, { type: 'CONNECT' });
    }

    async load(options: CastLoadOptions): Promise<void> {
        if (!this.transportId) await this.launch();
        const reply = await this.request(this.transportId, NS_MEDIA, {
            autoplay: options.autoplay,
            currentTime: options.currentTime,
            media: mediaInfo(options),
            type: 'LOAD',
        });
        if (reply.type !== 'MEDIA_STATUS') throw replyError(reply);
    }

    media(type: 'PAUSE' | 'PLAY' | 'STOP', extra: Record<string, unknown> = {}) {
        if (!this.transportId || !this.mediaSessionId) return;
        this.send(this.transportId, NS_MEDIA, {
            mediaSessionId: this.mediaSessionId,
            requestId: this.requestId++,
            type,
            ...extra,
        });
    }

    pollMedia() {
        if (!this.transportId) return;
        this.send(this.transportId, NS_MEDIA, { requestId: this.requestId++, type: 'GET_STATUS' });
    }

    // Appends a track to the device's queue; the receiver preloads it and switches over
    // on its own when the current one ends. Resolves to the new item's id.
    async queueInsert(options: CastLoadOptions): Promise<number> {
        if (!this.transportId || !this.mediaSessionId) throw new Error('Nothing loaded');
        const reply = await this.request(this.transportId, NS_MEDIA, {
            items: [{ autoplay: true, media: mediaInfo(options), preloadTime: 20 }],
            mediaSessionId: this.mediaSessionId,
            type: 'QUEUE_INSERT',
        });
        if (reply.type !== 'MEDIA_STATUS') throw replyError(reply);
        const ids: number[] = reply.status?.[0]?.items?.map((i: any) => i.itemId) ?? [];
        if (!ids.length) throw new Error('QUEUE_INSERT reply without queue items');
        return Math.max(...ids);
    }

    queueRemove(itemIds: number[]) {
        if (!this.transportId || !this.mediaSessionId || !itemIds.length) return;
        this.send(this.transportId, NS_MEDIA, {
            itemIds,
            mediaSessionId: this.mediaSessionId,
            requestId: this.requestId++,
            type: 'QUEUE_REMOVE',
        });
    }

    seek(seconds: number) {
        if (!this.transportId || !this.mediaSessionId) return;
        this.send(this.transportId, NS_MEDIA, {
            currentTime: seconds,
            mediaSessionId: this.mediaSessionId,
            requestId: this.requestId++,
            type: 'SEEK',
        });
    }

    // Volume of one member of a cast group. The device only accepts this while an app runs
    // on the group (NOT_LAUNCHED otherwise).
    async setMemberVolume(deviceId: string, volume: { level?: number; muted?: boolean }) {
        const reply = await this.request(RECEIVER, NS_MULTIZONE, {
            deviceId,
            sessionId: this.appSessionId || undefined,
            type: 'SET_DEVICE_VOLUME',
            volume,
        });
        if (reply.type === 'INVALID_REQUEST') throw replyError(reply);
    }

    setVolume(volume: { level?: number; muted?: boolean }) {
        this.send(RECEIVER, NS_RECEIVER, {
            requestId: this.requestId++,
            type: 'SET_VOLUME',
            volume,
        });
    }

    // Closes the media app on the device (the speaker goes idle).
    async stopApp(): Promise<void> {
        const status = await this.getReceiverStatus().catch(() => null);
        const app = status?.applications?.find((a: any) => a.transportId === this.transportId);
        if (app)
            await this.request(RECEIVER, NS_RECEIVER, { sessionId: app.sessionId, type: 'STOP' });
        this.transportId = '';
        this.mediaSessionId = 0;
    }

    private onData(chunk: Buffer) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const len = this.buffer.readUInt32BE(0);
            if (this.buffer.length < 4 + len) return;
            const msg = decodeMessage(this.buffer.subarray(4, 4 + len));
            this.buffer = this.buffer.subarray(4 + len);
            this.onMessage(msg);
        }
    }

    private onMessage({ namespace, payload, source }: ReturnType<typeof decodeMessage>) {
        let data: any;
        try {
            data = JSON.parse(payload);
        } catch {
            return;
        }
        if (namespace === NS_HEARTBEAT && data.type === 'PING') {
            this.send(source, NS_HEARTBEAT, { type: 'PONG' });
            return;
        }
        if (namespace === NS_CONNECTION && data.type === 'CLOSE' && source === this.transportId) {
            // Another sender took over the device, or the app was closed on it.
            this.transportId = '';
            this.mediaSessionId = 0;
            this.emit('app-closed');
        }
        if (data.type === 'RECEIVER_STATUS' && data.status?.volume) {
            this.emit('volume', data.status.volume);
            const ours = data.status.applications?.some(
                (a: any) => a.transportId === this.transportId,
            );
            if (this.transportId && !ours) {
                this.transportId = '';
                this.mediaSessionId = 0;
                this.emit('app-closed');
            }
        }
        if (namespace === NS_MULTIZONE && data.type === 'DEVICE_UPDATED' && data.device) {
            this.emit('member-volume', data.device);
        }
        if (data.type === 'MEDIA_STATUS') {
            for (const s of data.status ?? []) {
                if (s.mediaSessionId && !s.idleReason) this.mediaSessionId = s.mediaSessionId;
                this.emit('media', {
                    currentItemId: s.currentItemId,
                    currentTime: s.currentTime ?? 0,
                    duration: s.media?.duration ?? 0,
                    idleReason: s.idleReason,
                    itemIds: s.items?.map((i: any) => i.itemId),
                    mediaSessionId: s.mediaSessionId,
                    playerState: s.playerState,
                } satisfies CastMediaStatus);
            }
        }
        const resolve = this.pending.get(data.requestId);
        if (resolve) {
            this.pending.delete(data.requestId);
            resolve(data);
        }
    }

    private request(destination: string, ns: string, data: Record<string, unknown>): Promise<any> {
        const requestId = this.requestId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`${data.type} timed out`));
            }, 10000);
            this.pending.set(requestId, (msg) => {
                clearTimeout(timer);
                resolve(msg);
            });
            this.send(destination, ns, { ...data, requestId });
        });
    }

    private send(destination: string, ns: string, data: Record<string, unknown>) {
        this.socket?.write(encodeMessage(SENDER, destination, ns, JSON.stringify(data)));
    }
}
