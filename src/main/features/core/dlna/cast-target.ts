// Drives a Chromecast behind the same dlna-* IPC channels the DLNA target uses, so the
// renderer's DLNA engine and device list work unchanged. Cast devices are listed as
// DlnaDevices whose controlUrl is cast://host:port.
import type { DlnaDevice, TrackMetadata } from './soap-client';

import { getMainWindow } from '../../../index';
import { CastGroupMember, CastMediaStatus, CastSession, discoverCastDevices } from './cast-client';

import log from '/@/main/logger';

const castLog = (action: string, err?: unknown) => log.info(`[Cast] ${action}`, err);
const send = (channel: string, payload?: unknown) =>
    getMainWindow()?.webContents.send(channel, payload);

export const isCastDevice = (device?: DlnaDevice | null) =>
    !!device?.controlUrl.startsWith('cast://');

let session: CastSession | null = null;
let device: DlnaDevice | null = null;
// The track the engine wants next, and what of it is actually in the device's queue.
let queuedNext: null | { metadata: TrackMetadata; url: string } = null;
let queuedItem: null | { id: number; url: string } = null;
let queueSync: Promise<void> = Promise.resolve();
let currentItemId: number | undefined;
let currentUrl = '';
let loadedAt = 0;
let positionOffset = 0;
let position = 0;
let positionAt = 0;
let playerState = '';
let finishedKey = '';
let radioMode = false;
let volume = 50;
let poll: NodeJS.Timeout | null = null;
// Members of a connected cast group; empty for a single device.
let members: CastGroupMember[] = [];
const MEMBER_PREFIX = 'cast-member-';

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
        // A single device lists itself as its only member.
        members = await next.getGroupMembers().catch(() => []);
        if (members.length < 2) members = [];
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
    queuedItem = null;
    next.on('media', onMedia);
    next.on('member-volume', (updated: CastGroupMember) => {
        members = members.map((m) => (m.deviceId === updated.deviceId ? updated : m));
        send('renderer-dlna-group-member-volume', {
            deviceId: MEMBER_PREFIX + updated.deviceId,
            volume: Math.round(updated.volume.level * 100),
        });
    });
    next.on('volume', (v: { level?: number }) => {
        const level = Math.round((v.level ?? 0) * 100);
        if (level === volume) return;
        volume = level;
        send('renderer-dlna-volume', level);
    });
    next.on('app-closed', () => {
        if (session !== next) return;
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
    members = [];
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

// A cast group is shown as its own coordinator (the master volume) plus its members.
export function getGroupState() {
    if (!device) return [];
    const group = device;
    return [
        { device: group, isCoordinator: true, volume },
        ...members.map((m) => ({
            device: { ...group, id: MEMBER_PREFIX + m.deviceId, name: m.name },
            isCoordinator: false,
            volume: Math.round(m.volume.level * 100),
        })),
    ];
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

export function setMemberVolume(memberId: string, value: { level?: number; muted?: boolean }) {
    if (!session) return;
    const deviceId = memberId.replace(MEMBER_PREFIX, '');
    session
        .setMemberVolume(deviceId, value)
        .catch((err) => castLog(`Failed to set volume of group member ${deviceId}`, err));
}

export function setMute(muted: boolean) {
    session?.setVolume({ muted });
}

export function setNext(data: { metadata: TrackMetadata; url: string }) {
    queuedNext = data.url ? data : null;
    syncQueue();
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

// The current track ended and the device did not move on by itself.
function finishTrack() {
    currentUrl = '';
    const next = queuedNext;
    queuedNext = null;
    queuedItem = null;
    if (next) {
        // Load the next track right away; gapless: true tells the engine the device already
        // moved on, so it only has to queue the one after.
        void load(next.url, { ...next.metadata, autoPlay: true }, 0, 0);
        send('renderer-dlna-track-ended', { gapless: true });
    } else {
        send('renderer-dlna-track-ended', { gapless: false });
    }
}

async function load(url: string, metadata: TrackMetadata, seekTo: number, offset: number) {
    if (!session) return;
    currentUrl = url;
    currentItemId = undefined;
    queuedItem = null; // LOAD replaces the device's queue
    loadedAt = Date.now();
    positionOffset = offset;
    position = offset + seekTo;
    positionAt = Date.now();
    try {
        await session.load(toLoadOptions(url, metadata, seekTo));
        castLog(`Playing: ${metadata.title}`);
        syncQueue();
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

    if (status.currentItemId !== undefined && status.currentItemId !== currentItemId) {
        const previousItemId = currentItemId;
        currentItemId = status.currentItemId;
        if (queuedItem && status.currentItemId === queuedItem.id) {
            // The device moved on to the preloaded track by itself (gapless).
            castLog('Advanced to the queued track');
            currentUrl = queuedItem.url;
            queuedItem = null;
            queuedNext = null;
            positionOffset = 0;
            loadedAt = Date.now();
            if (previousItemId !== undefined) session?.queueRemove([previousItemId]);
            send('renderer-dlna-track-ended', { gapless: true });
            return;
        }
        // First status of a fresh LOAD: the queue can be filled now.
        syncQueue();
    }

    if (status.playerState === 'IDLE' && status.idleReason === 'FINISHED') {
        // Polls keep reporting a finished item until something new plays; act once.
        const finished = `${status.mediaSessionId}/${status.currentItemId}`;
        if (!currentUrl || finished === finishedKey) return;
        finishedKey = finished;
        if (queuedItem) {
            // The device is switching to the preloaded item; the currentItemId change above
            // reports it. Only step in if that never happens.
            const waitingFor = queuedItem;
            setTimeout(() => {
                if (queuedItem !== waitingFor || !session) return;
                castLog('Device did not advance to the queued track, loading it');
                finishTrack();
            }, 4000);
            return;
        }
        finishTrack();
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

// Brings the device's queue in line with queuedNext: at most one item after the current one.
function syncQueue() {
    queueSync = queueSync.then(async () => {
        if (!session || !currentUrl || currentItemId === undefined) return;
        const wanted = radioMode ? null : queuedNext;
        if (queuedItem?.url === wanted?.url) return;
        if (queuedItem) {
            session.queueRemove([queuedItem.id]);
            queuedItem = null;
        }
        if (!wanted) return;
        try {
            const id = await session.queueInsert(toLoadOptions(wanted.url, wanted.metadata, 0));
            queuedItem = { id, url: wanted.url };
            castLog(`Queued next: ${wanted.metadata.title}`);
        } catch (err) {
            // Not fatal: the track is loaded when the current one finishes instead.
            castLog(`Failed to queue ${wanted.metadata.title}`, err);
        }
    });
}

function toLoadOptions(url: string, metadata: TrackMetadata, seekTo: number) {
    return {
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
    };
}
