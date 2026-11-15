// Drives a Chromecast behind the same dlna-* IPC channels the DLNA target uses, so the
// renderer's DLNA engine and device list work unchanged. Cast devices are listed as
// DlnaDevices whose controlUrl is cast://host:port.
import type { DlnaDevice, TrackMetadata } from './soap-client';

import { getMainWindow } from '../../../index';
import { CastMediaStatus, CastSession, discoverCastDevices } from './cast-client';

import log from '/@/main/logger';

const castLog = (action: string, err?: unknown) => log.info(`[Cast] ${action}`, err);
const send = (channel: string, payload?: unknown) =>
    getMainWindow()?.webContents.send(channel, payload);

export const isCastDevice = (device?: DlnaDevice | null) =>
    !!device?.controlUrl.startsWith('cast://');

let session: CastSession | null = null;
let device: DlnaDevice | null = null;
let queuedNext: null | { metadata: TrackMetadata; url: string } = null;
let currentUrl = '';
let loadedAt = 0;
let positionOffset = 0;
let position = 0;
let positionAt = 0;
let playerState = '';
let finishedSessionId = 0;
let radioMode = false;
let volume = 50;
let poll: NodeJS.Timeout | null = null;

export const isCastActive = () => session !== null;

export async function connect(target: DlnaDevice) {
    await disconnect(true);
    const { hostname, port } = new URL(target.controlUrl.replace('cast://', 'http://'));
    const next = new CastSession({
        host: hostname,
        id: target.id,
        isGroup: false,
        model: '',
        name: target.name,
        port: Number(port),
    });
    try {
        await next.connect();
        const status = await next.getReceiverStatus();
        volume = Math.round((status?.volume?.level ?? 0.5) * 100);
    } catch (err) {
        castLog(`Failed to connect to ${target.name}`, err);
        next.close();
        return { success: false, volume: 50 };
    }
    session = next;
    device = target;
    position = 0;
    playerState = '';
    currentUrl = '';
    queuedNext = null;
    next.on('media', onMedia);
    next.on('volume', (v: { level?: number }) => {
        const level = Math.round((v.level ?? 0) * 100);
        if (level === volume) return;
        volume = level;
        send('renderer-dlna-volume', level);
    });
    next.on('app-closed', () => {
        castLog('Media app closed on the device (another sender took over?)');
        currentUrl = '';
        if (playerState !== 'IDLE') send('renderer-dlna-transport-state', 'STOPPED');
        playerState = 'IDLE';
    });
    next.on('close', () => {
        if (session !== next) return;
        castLog(`Connection to ${target.name} lost`);
        send('renderer-dlna-toast', {
            message: `Lost connection to ${target.name}`,
            type: 'error',
        });
        send('renderer-dlna-transport-state', 'STOPPED');
        stopPolling();
        session = null;
    });
    poll = setInterval(() => {
        session?.pollMedia();
        if (playerState === 'PLAYING') send('renderer-dlna-current-time', getPosition());
    }, 1000);
    castLog(`Connected to ${target.name}`);
    sendGroupState();
    return {
        currentDuration: 0,
        currentPosition: 0,
        currentTransportState: 'STOPPED',
        currentUri: '',
        nextUri: '',
        success: true,
        volume,
    };
}

// passive: leave the speaker playing (the app stops controlling it).
export async function disconnect(passive = false) {
    if (!session) return;
    const old = session;
    session = null;
    stopPolling();
    if (!passive) await old.stopApp().catch((err) => castLog('Failed to stop app', err));
    old.close();
    castLog(`Disconnected from ${device?.name}${passive ? ' (speaker keeps playing)' : ''}`);
    device = null;
    send('renderer-dlna-group-state', []);
}

export async function discover(): Promise<DlnaDevice[]> {
    try {
        const found = await discoverCastDevices();
        castLog(`Found ${found.length} cast device(s)`);
        return found.map((d) => ({
            controlUrl: `cast://${d.host}:${d.port}`,
            id: `cast-${d.id}`,
            location: `cast://${d.host}:${d.port}`,
            name: d.isGroup ? `${d.name} (Cast group)` : `${d.name} (Chromecast)`,
            renderingControlUrl: '',
        }));
    } catch (err) {
        castLog('Discovery failed', err);
        return [];
    }
}

export function getGroupState() {
    if (!device) return [];
    return [{ device, isCoordinator: true, volume }];
}

export function getPosition() {
    const elapsed = playerState === 'PLAYING' ? (Date.now() - positionAt) / 1000 : 0;
    return position + elapsed;
}

export function pause() {
    session?.media('PAUSE');
}

export function play() {
    session?.media('PLAY');
}

export async function playUrl(data: {
    isMuted?: boolean;
    metadata: TrackMetadata;
    positionOffset?: number;
    seekTo?: number;
    url: string;
}) {
    // The engine may re-send the track main already advanced to on its own.
    if (data.url === currentUrl && !data.seekTo && Date.now() - loadedAt < 3000) return;
    queuedNext = null;
    await load(data.url, data.metadata, data.seekTo ?? 0, data.positionOffset ?? 0);
    if (data.isMuted !== undefined) session?.setVolume({ muted: data.isMuted });
}

export function seek(seconds: number) {
    position = seconds;
    positionAt = Date.now();
    session?.seek(Math.max(0, seconds - positionOffset));
}

export function setMute(muted: boolean) {
    session?.setVolume({ muted });
}

export function setNext(data: { metadata: TrackMetadata; url: string }) {
    queuedNext = data.url ? data : null;
}

export function setRadioMode(enabled: boolean) {
    radioMode = enabled;
}

export function setVolume(value: number) {
    volume = value;
    session?.setVolume({ level: value / 100 });
}

export function stop() {
    currentUrl = '';
    session?.media('STOP');
}

async function load(url: string, metadata: TrackMetadata, seekTo: number, offset: number) {
    if (!session) return;
    currentUrl = url;
    loadedAt = Date.now();
    positionOffset = offset;
    position = offset + seekTo;
    positionAt = Date.now();
    try {
        await session.load({
            albumArtUrl: metadata.albumArtUrl,
            albumName: metadata.albumName,
            artistName: metadata.artistName,
            autoplay: metadata.autoPlay !== false,
            contentType: metadata.mimeType || 'audio/mpeg',
            currentTime: seekTo,
            duration: metadata.duration,
            live: radioMode,
            title: metadata.title,
            url,
        });
        castLog(`Playing: ${metadata.title}`);
    } catch (err) {
        castLog(`Failed to load ${metadata.title}`, err);
        send('renderer-dlna-toast', {
            message: `Chromecast could not play "${metadata.title}": ${(err as Error).message}`,
            type: 'error',
        });
    }
}

function onMedia(status: CastMediaStatus) {
    if (status.playerState !== 'IDLE') {
        position = status.currentTime + positionOffset;
        positionAt = Date.now();
    }
    const previous = playerState;
    playerState = status.playerState;

    if (status.playerState === 'IDLE' && status.idleReason === 'FINISHED') {
        // Polls keep reporting a finished session until the next LOAD lands; act once.
        if (!currentUrl || status.mediaSessionId === finishedSessionId) return;
        finishedSessionId = status.mediaSessionId;
        currentUrl = '';
        const next = queuedNext;
        queuedNext = null;
        if (next) {
            // Load the queued track right away; gapless: true tells the engine the device
            // already moved on, so it only has to queue the one after.
            void load(next.url, { ...next.metadata, autoPlay: true }, 0, 0);
            send('renderer-dlna-track-ended', { gapless: true });
        } else {
            send('renderer-dlna-track-ended', { gapless: false });
        }
        return;
    }
    if (status.playerState === 'IDLE' && status.idleReason === 'ERROR') {
        castLog('Playback error reported by the device');
        send('renderer-dlna-toast', {
            message: 'Chromecast reported a playback error',
            type: 'error',
        });
    }
    if (previous === status.playerState) return;
    if (status.playerState === 'PLAYING') send('renderer-dlna-transport-state', 'PLAYING');
    if (status.playerState === 'PAUSED') send('renderer-dlna-transport-state', 'PAUSED_PLAYBACK');
}

function sendGroupState() {
    send('renderer-dlna-group-state', getGroupState());
}

function stopPolling() {
    if (poll) clearInterval(poll);
    poll = null;
}
