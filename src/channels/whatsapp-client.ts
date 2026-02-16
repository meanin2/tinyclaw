#!/usr/bin/env node
/**
 * WhatsApp Client for TinyClaw — Baileys Edition
 *
 * Drop-in replacement for the whatsapp-web.js client.  Uses
 * @whiskeysockets/baileys (pure Node.js, no Chromium) so it works
 * reliably on ARM64, Docker, and headless servers.
 *
 * Writes incoming messages to the file-based queue and polls the
 * outgoing queue to send responses — the same contract as every
 * other TinyClaw channel client.
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    WAMessageContent,
    WAMessageKey,
    proto,
    downloadMediaMessage,
    getContentType,
    extensionForMediaMessage,
} from 'baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { ensureSenderPaired } from '../lib/pairing';
import pino from 'pino';

// ─── Path constants ────────────────────────────────────────────────
const SCRIPT_DIR = path.resolve(__dirname, '..', '..');
const _localTinyclaw = path.join(SCRIPT_DIR, '.tinyclaw');
const TINYCLAW_HOME = process.env.TINYCLAW_HOME
    || (fs.existsSync(path.join(_localTinyclaw, 'settings.json'))
        ? _localTinyclaw
        : path.join(require('os').homedir(), '.tinyclaw'));
const QUEUE_INCOMING = path.join(TINYCLAW_HOME, 'queue/incoming');
const QUEUE_OUTGOING = path.join(TINYCLAW_HOME, 'queue/outgoing');
const LOG_FILE = path.join(TINYCLAW_HOME, 'logs/whatsapp.log');
const SETTINGS_FILE = path.join(TINYCLAW_HOME, 'settings.json');
const FILES_DIR = path.join(TINYCLAW_HOME, 'files');
const PAIRING_FILE = path.join(TINYCLAW_HOME, 'pairing.json');
const WHITELIST_FILE = path.join(TINYCLAW_HOME, 'whitelist.json');
const AUTH_DIR = path.join(TINYCLAW_HOME, 'baileys-auth');

// Ensure required directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, path.dirname(LOG_FILE), FILES_DIR, AUTH_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ─── Interfaces ────────────────────────────────────────────────────

interface PendingMessage {
    key: WAMessageKey;
    jid: string;
    timestamp: number;
}

interface QueueData {
    channel: string;
    sender: string;
    senderId: string;
    message: string;
    timestamp: number;
    messageId: string;
    files?: string[];
}

interface ResponseData {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
    files?: string[];
}

interface WhitelistData {
    whatsapp?: string[];
}

// ─── State ─────────────────────────────────────────────────────────

const pendingMessages = new Map<string, PendingMessage>();
let processingOutgoingQueue = false;
let sock: ReturnType<typeof makeWASocket> | null = null;
let outgoingInterval: ReturnType<typeof setInterval> | null = null;

// ─── Logger ────────────────────────────────────────────────────────

function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    try {
        fs.appendFileSync(LOG_FILE, logMessage);
    } catch {
        // Swallow write errors — logging should never crash the client
    }
}

// ─── Whitelist ─────────────────────────────────────────────────────

function loadWhitelist(): string[] | null {
    try {
        if (!fs.existsSync(WHITELIST_FILE)) return null;
        const raw: WhitelistData = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
        if (raw.whatsapp && Array.isArray(raw.whatsapp) && raw.whatsapp.length > 0) {
            return raw.whatsapp;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Extract a bare phone number from a WhatsApp JID.
 * "972548790112@s.whatsapp.net" → "972548790112"
 */
function bareNumber(jid: string): string {
    return jid.replace(/@.*$/, '');
}

function isWhitelisted(jid: string): boolean {
    const whitelist = loadWhitelist();
    if (!whitelist) return true; // No whitelist → allow all (fall through to pairing)
    return whitelist.includes(bareNumber(jid));
}

function hasWhitelist(): boolean {
    return loadWhitelist() !== null;
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Derive a file extension from a MIME type string.
 */
function extFromMime(mime?: string): string {
    if (!mime) return '.bin';
    const map: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'audio/ogg': '.ogg',
        'audio/ogg; codecs=opus': '.ogg',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a',
        'video/mp4': '.mp4',
        'application/pdf': '.pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'text/plain': '.txt',
    };
    return map[mime] || `.${mime.split('/')[1] || 'bin'}`;
}

/**
 * Derive MIME type from a file extension (for outgoing attachments).
 */
function mimeFromExt(ext: string): string {
    const map: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.ogg': 'audio/ogg; codecs=opus',
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.mp4': 'video/mp4',
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain',
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Download media from a Baileys WAMessage and save to FILES_DIR.
 */
async function downloadBaileysMedia(
    msg: proto.IWebMessageInfo,
    queueMessageId: string,
): Promise<string | null> {
    try {
        const buffer = await downloadMediaMessage(
            msg as any,
            'buffer',
            {},
        ) as Buffer;

        if (!buffer || buffer.length === 0) return null;

        // Try to get the original filename for documents
        const messageContent = msg.message;
        let ext = '.bin';
        if (messageContent) {
            // Check for document with a filename
            const docMsg = messageContent.documentMessage
                || messageContent.documentWithCaptionMessage?.message?.documentMessage;
            if (docMsg?.fileName) {
                ext = path.extname(docMsg.fileName) || extFromMime(docMsg.mimetype || undefined);
            } else {
                // Use Baileys' built-in extension detection, fall back to mime map
                try {
                    ext = extensionForMediaMessage(messageContent as WAMessageContent);
                    if (ext && !ext.startsWith('.')) ext = `.${ext}`;
                } catch {
                    // Fall back to mime-based detection
                    const contentType = getContentType(messageContent as proto.IMessage);
                    if (contentType) {
                        const inner = (messageContent as any)[contentType];
                        if (inner?.mimetype) {
                            ext = extFromMime(inner.mimetype);
                        }
                    }
                }
            }
        }

        const filename = `whatsapp_${queueMessageId}_${Date.now()}${ext}`;
        const localPath = path.join(FILES_DIR, filename);
        fs.writeFileSync(localPath, buffer);

        // Determine mimetype for logging
        const contentType = messageContent ? getContentType(messageContent as proto.IMessage) : undefined;
        const mimetype = contentType ? (messageContent as any)?.[contentType]?.mimetype : 'unknown';
        log('INFO', `Downloaded media: ${filename} (${mimetype})`);

        return localPath;
    } catch (error) {
        log('ERROR', `Failed to download media: ${(error as Error).message}`);
        return null;
    }
}

/**
 * Extract text body from a Baileys message.  Handles extended text,
 * image/video/document captions, and plain conversation messages.
 */
function extractMessageText(messageContent: proto.IMessage | null | undefined): string {
    if (!messageContent) return '';

    // Plain text conversation
    if (messageContent.conversation) {
        return messageContent.conversation;
    }

    // Extended text (links, formatting, etc.)
    if (messageContent.extendedTextMessage?.text) {
        return messageContent.extendedTextMessage.text;
    }

    // Image caption
    if (messageContent.imageMessage?.caption) {
        return messageContent.imageMessage.caption;
    }

    // Video caption
    if (messageContent.videoMessage?.caption) {
        return messageContent.videoMessage.caption;
    }

    // Document caption (direct or inside documentWithCaption wrapper)
    if (messageContent.documentMessage?.caption) {
        return messageContent.documentMessage.caption;
    }
    if (messageContent.documentWithCaptionMessage?.message?.documentMessage?.caption) {
        return messageContent.documentWithCaptionMessage.message.documentMessage.caption;
    }

    return '';
}

/**
 * Check whether a Baileys message contains downloadable media.
 */
function hasDownloadableMedia(messageContent: proto.IMessage | null | undefined): boolean {
    if (!messageContent) return false;
    return !!(
        messageContent.imageMessage
        || messageContent.audioMessage
        || messageContent.videoMessage
        || messageContent.documentMessage
        || messageContent.stickerMessage
        || messageContent.documentWithCaptionMessage?.message?.documentMessage
    );
}

/**
 * Get the sender's push-name (display name) from a Baileys message.
 */
function getSenderName(msg: proto.IWebMessageInfo): string {
    return msg.pushName || bareNumber(msg.key.remoteJid || '');
}

// ─── Settings helpers (agent / team listing, reset) ────────────────

function getAgentListText(): string {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        const agents = settings.agents;
        if (!agents || Object.keys(agents).length === 0) {
            return 'No agents configured. Using default single-agent mode.\n\nConfigure agents in .tinyclaw/settings.json or run: tinyclaw agent add';
        }
        let text = '*Available Agents:*\n';
        for (const [id, agent] of Object.entries(agents) as [string, any][]) {
            text += `\n@${id} - ${agent.name}`;
            text += `\n  Provider: ${agent.provider}/${agent.model}`;
            text += `\n  Directory: ${agent.working_directory}`;
            if (agent.system_prompt) text += `\n  Has custom system prompt`;
            if (agent.prompt_file) text += `\n  Prompt file: ${agent.prompt_file}`;
        }
        text += '\n\nUsage: Start your message with @agent_id to route to a specific agent.';
        return text;
    } catch {
        return 'Could not load agent configuration.';
    }
}

function getTeamListText(): string {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        const teams = settings.teams;
        if (!teams || Object.keys(teams).length === 0) {
            return 'No teams configured.\n\nCreate a team with: tinyclaw team add';
        }
        let text = '*Available Teams:*\n';
        for (const [id, team] of Object.entries(teams) as [string, any][]) {
            text += `\n@${id} - ${team.name}`;
            text += `\n  Agents: ${team.agents.join(', ')}`;
            text += `\n  Leader: @${team.leader_agent}`;
        }
        text += '\n\nUsage: Start your message with @team_id to route to a team.';
        return text;
    } catch {
        return 'Could not load team configuration.';
    }
}

function pairingMessage(code: string): string {
    return [
        'This sender is not paired yet.',
        `Your pairing code: ${code}`,
        'Ask the TinyClaw owner to approve you with:',
        `tinyclaw pairing approve ${code}`,
    ].join('\n');
}

// ─── Outgoing queue processor ──────────────────────────────────────

async function checkOutgoingQueue(): Promise<void> {
    if (processingOutgoingQueue || !sock) return;

    processingOutgoingQueue = true;

    try {
        const files = fs.readdirSync(QUEUE_OUTGOING)
            .filter(f => f.startsWith('whatsapp_') && f.endsWith('.json'));

        for (const file of files) {
            const filePath = path.join(QUEUE_OUTGOING, file);

            try {
                const responseData: ResponseData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const { messageId, message: responseText, sender, senderId } = responseData;

                // Determine the target JID
                const pending = pendingMessages.get(messageId);
                let targetJid: string | null = pending?.jid ?? null;

                if (!targetJid && senderId) {
                    targetJid = senderId.includes('@') ? senderId : `${senderId}@s.whatsapp.net`;
                }

                if (!targetJid) {
                    log('WARN', `No pending message for ${messageId} and no senderId, cleaning up`);
                    fs.unlinkSync(filePath);
                    continue;
                }

                // Send any attached files first
                if (responseData.files && responseData.files.length > 0) {
                    for (const attachmentPath of responseData.files) {
                        try {
                            if (!fs.existsSync(attachmentPath)) continue;

                            const ext = path.extname(attachmentPath).toLowerCase();
                            const mimetype = mimeFromExt(ext);
                            const fileBuffer = fs.readFileSync(attachmentPath);
                            const filename = path.basename(attachmentPath);

                            if (mimetype.startsWith('image/')) {
                                await sock.sendMessage(targetJid, {
                                    image: fileBuffer,
                                    mimetype,
                                    fileName: filename,
                                });
                            } else if (mimetype.startsWith('video/')) {
                                await sock.sendMessage(targetJid, {
                                    video: fileBuffer,
                                    mimetype,
                                    fileName: filename,
                                });
                            } else if (mimetype.startsWith('audio/')) {
                                await sock.sendMessage(targetJid, {
                                    audio: fileBuffer,
                                    mimetype,
                                    fileName: filename,
                                });
                            } else {
                                // Send as document for everything else
                                await sock.sendMessage(targetJid, {
                                    document: fileBuffer,
                                    mimetype,
                                    fileName: filename,
                                });
                            }

                            log('INFO', `Sent file to WhatsApp: ${filename}`);
                        } catch (fileErr) {
                            log('ERROR', `Failed to send file ${attachmentPath}: ${(fileErr as Error).message}`);
                        }
                    }
                }

                // Send text response
                if (responseText) {
                    if (pending?.key) {
                        // Reply to the original message (quoted)
                        await sock.sendMessage(targetJid, {
                            text: responseText,
                        }, {
                            quoted: {
                                key: pending.key,
                                message: undefined,
                            } as any,
                        });
                    } else {
                        // No original message context — send standalone
                        await sock.sendMessage(targetJid, {
                            text: responseText,
                        });
                    }
                }

                const fileCount = responseData.files ? `, ${responseData.files.length} file(s)` : '';
                log('INFO', `Sent ${pending ? 'response' : 'proactive message'} to ${sender} (${responseText.length} chars${fileCount})`);

                if (pending) pendingMessages.delete(messageId);
                fs.unlinkSync(filePath);
            } catch (error) {
                log('ERROR', `Error processing response file ${file}: ${(error as Error).message}`);
                // Don't delete file on error — may retry on next cycle
            }
        }
    } catch (error) {
        log('ERROR', `Outgoing queue error: ${(error as Error).message}`);
    } finally {
        processingOutgoingQueue = false;
    }
}

// ─── Pending message cleanup ───────────────────────────────────────

function cleanupPendingMessages(): void {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const [id, data] of pendingMessages.entries()) {
        if (data.timestamp < tenMinutesAgo) {
            pendingMessages.delete(id);
        }
    }
}

// ─── Graceful shutdown ─────────────────────────────────────────────

function removeReadyFlag(): void {
    const readyFile = path.join(SCRIPT_DIR, '.tinyclaw/channels/whatsapp_ready');
    try {
        if (fs.existsSync(readyFile)) {
            fs.unlinkSync(readyFile);
        }
    } catch {
        // best-effort
    }
}

async function shutdown(signal: string): Promise<void> {
    log('INFO', `Shutting down WhatsApp client (${signal})...`);
    removeReadyFlag();
    if (outgoingInterval) {
        clearInterval(outgoingInterval);
        outgoingInterval = null;
    }
    if (sock) {
        try {
            sock.end(undefined);
        } catch {
            // ignore
        }
        sock = null;
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Main connection logic ─────────────────────────────────────────

async function connectToWhatsApp(): Promise<void> {
    const logger = pino({ level: 'silent' }) as any;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    log('INFO', `Using WA v${version.join('.')}`);

    sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        version,
        logger,
        printQRInTerminal: false,
        browser: ['TinyClaw', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
    });

    // ── Credential persistence ──────────────────────────────────
    sock.ev.on('creds.update', saveCreds);

    // ── Connection state machine ────────────────────────────────
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ── QR code ─────────────────────────────────────────────
        if (qr) {
            log('INFO', 'Scan this QR code with WhatsApp:');
            console.log('\n');

            // Display in terminal
            qrcode.generate(qr, { small: true });

            // Persist for tinyclaw.sh / UI consumption
            const channelsDir = path.join(SCRIPT_DIR, '.tinyclaw/channels');
            if (!fs.existsSync(channelsDir)) {
                fs.mkdirSync(channelsDir, { recursive: true });
            }
            // Save ASCII-art QR
            qrcode.generate(qr, { small: true }, (code: string) => {
                fs.writeFileSync(path.join(channelsDir, 'whatsapp_qr.txt'), code);
                log('INFO', 'QR code saved to .tinyclaw/channels/whatsapp_qr.txt');
            });
            // Save raw QR string (for web UI QR renderers, etc.)
            fs.writeFileSync(path.join(channelsDir, 'whatsapp_qr_raw.txt'), qr);

            console.log('\n');
            log('INFO', 'Open WhatsApp -> Settings -> Linked Devices -> Link a Device');
        }

        // ── Connection opened ───────────────────────────────────
        if (connection === 'open') {
            log('INFO', 'WhatsApp client connected and ready!');
            log('INFO', 'Listening for messages...');

            // Create ready flag
            const channelsDir = path.join(SCRIPT_DIR, '.tinyclaw/channels');
            if (!fs.existsSync(channelsDir)) {
                fs.mkdirSync(channelsDir, { recursive: true });
            }
            fs.writeFileSync(
                path.join(channelsDir, 'whatsapp_ready'),
                Date.now().toString(),
            );
        }

        // ── Connection closed ───────────────────────────────────
        if (connection === 'close') {
            removeReadyFlag();

            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
                ?? (lastDisconnect?.error as any)?.output?.statusCode;

            if (statusCode === DisconnectReason.loggedOut) {
                log('WARN', 'WhatsApp session logged out — clearing auth and reconnecting for fresh QR');
                // Clear auth directory so next connection produces a new QR
                try {
                    const authFiles = fs.readdirSync(AUTH_DIR);
                    for (const f of authFiles) {
                        fs.unlinkSync(path.join(AUTH_DIR, f));
                    }
                } catch {
                    // best effort
                }
                // Reconnect (will show fresh QR)
                setTimeout(() => connectToWhatsApp(), 2000);
            } else {
                const reason = statusCode
                    ? `status ${statusCode}`
                    : (lastDisconnect?.error as Error)?.message || 'unknown';
                log('WARN', `WhatsApp disconnected (${reason}) — reconnecting...`);
                // Reconnect with a small backoff
                const delay = statusCode === DisconnectReason.restartRequired ? 0 : 3000;
                setTimeout(() => connectToWhatsApp(), delay);
            }
        }
    });

    // ── Incoming messages ───────────────────────────────────────
    sock.ev.on('messages.upsert', async (upsert) => {
        // Only process "notify" type (real incoming messages)
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
            try {
                // Skip messages from self
                if (msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid || '';

                // Skip group messages
                if (remoteJid.endsWith('@g.us')) continue;

                // Skip status broadcasts
                if (remoteJid === 'status@broadcast') continue;

                const messageContent = msg.message;
                if (!messageContent) continue;

                const messageText = extractMessageText(messageContent);
                const hasMedia = hasDownloadableMedia(messageContent);

                // Skip messages that are neither text nor media
                if (!messageText && !hasMedia) continue;

                // ── Whitelist check (CRITICAL) ──────────────────
                if (hasWhitelist() && !isWhitelisted(remoteJid)) {
                    log('INFO', `Blocked non-whitelisted sender: ${bareNumber(remoteJid)}`);
                    continue; // Silently ignore
                }

                const sender = getSenderName(msg);
                const messageId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;

                // ── Pairing check (only if no whitelist) ────────
                if (!hasWhitelist()) {
                    const pairing = ensureSenderPaired(PAIRING_FILE, 'whatsapp', remoteJid, sender);
                    if (!pairing.approved && pairing.code) {
                        if (pairing.isNewPending) {
                            log('INFO', `Blocked unpaired WhatsApp sender ${sender} (${remoteJid}) with code ${pairing.code}`);
                            await sock!.sendMessage(remoteJid, {
                                text: pairingMessage(pairing.code),
                            });
                        } else {
                            log('INFO', `Blocked pending WhatsApp sender ${sender} (${remoteJid}) without re-sending pairing message`);
                        }
                        continue;
                    }
                }

                log('INFO', `Message from ${sender}: ${messageText.substring(0, 50)}${hasMedia ? ` [+media]` : ''}...`);

                // ── Special commands ────────────────────────────

                // /agent or !agent
                if (messageText.trim().match(/^[!/]agent$/i)) {
                    log('INFO', 'Agent list command received');
                    await sock!.sendMessage(remoteJid, { text: getAgentListText() });
                    continue;
                }

                // /team or !team
                if (messageText.trim().match(/^[!/]team$/i)) {
                    log('INFO', 'Team list command received');
                    await sock!.sendMessage(remoteJid, { text: getTeamListText() });
                    continue;
                }

                // /reset (no args)
                if (messageText.trim().match(/^[!/]reset$/i)) {
                    await sock!.sendMessage(remoteJid, {
                        text: 'Usage: /reset @agent_id [@agent_id2 ...]\nSpecify which agent(s) to reset.',
                    });
                    continue;
                }

                // /reset @agent_id [@agent_id2 ...]
                const resetMatch = messageText.trim().match(/^[!/]reset\s+(.+)$/i);
                if (resetMatch) {
                    log('INFO', 'Per-agent reset command received');
                    const agentArgs = resetMatch[1].split(/\s+/).map(a => a.replace(/^@/, '').toLowerCase());
                    try {
                        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
                        const settings = JSON.parse(settingsData);
                        const agents = settings.agents || {};
                        const workspacePath = settings?.workspace?.path
                            || path.join(require('os').homedir(), 'tinyclaw-workspace');
                        const resetResults: string[] = [];
                        for (const agentId of agentArgs) {
                            if (!agents[agentId]) {
                                resetResults.push(`Agent '${agentId}' not found.`);
                                continue;
                            }
                            const flagDir = path.join(workspacePath, agentId);
                            if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
                            fs.writeFileSync(path.join(flagDir, 'reset_flag'), 'reset');
                            resetResults.push(`Reset @${agentId} (${agents[agentId].name}).`);
                        }
                        await sock!.sendMessage(remoteJid, { text: resetResults.join('\n') });
                    } catch {
                        await sock!.sendMessage(remoteJid, {
                            text: 'Could not process reset command. Check settings.',
                        });
                    }
                    continue;
                }

                // ── Send typing indicator ───────────────────────
                try {
                    await sock!.sendPresenceUpdate('composing', remoteJid);
                } catch {
                    // Non-critical, ignore
                }

                // ── Download media ──────────────────────────────
                const downloadedFiles: string[] = [];
                if (hasMedia) {
                    const filePath = await downloadBaileysMedia(msg, messageId);
                    if (filePath) {
                        downloadedFiles.push(filePath);
                    }
                }

                // Build message text with file references
                let fullMessage = messageText;
                if (downloadedFiles.length > 0) {
                    const fileRefs = downloadedFiles.map(f => `[file: ${f}]`).join('\n');
                    fullMessage = fullMessage ? `${fullMessage}\n\n${fileRefs}` : fileRefs;
                }

                // If a sticker with no text, add placeholder
                if (!fullMessage && messageContent.stickerMessage) {
                    fullMessage = '[Sticker]';
                }

                // Skip if still no content
                if ((!fullMessage || fullMessage.trim().length === 0) && downloadedFiles.length === 0) {
                    continue;
                }

                // ── Write to incoming queue ─────────────────────
                const queueData: QueueData = {
                    channel: 'whatsapp',
                    sender: sender,
                    senderId: remoteJid,
                    message: fullMessage,
                    timestamp: Date.now(),
                    messageId: messageId,
                    files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
                };

                const queueFile = path.join(QUEUE_INCOMING, `whatsapp_${messageId}.json`);
                fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2));

                log('INFO', `Queued message ${messageId}`);

                // ── Track for reply context ─────────────────────
                pendingMessages.set(messageId, {
                    key: msg.key,
                    jid: remoteJid,
                    timestamp: Date.now(),
                });

                // Housekeeping — evict stale entries
                cleanupPendingMessages();

            } catch (error) {
                log('ERROR', `Message handling error: ${(error as Error).message}`);
            }
        }
    });

    // ── Start outgoing queue poller ─────────────────────────────
    if (outgoingInterval) clearInterval(outgoingInterval);
    outgoingInterval = setInterval(checkOutgoingQueue, 1000);
}

// ─── Entry point ───────────────────────────────────────────────────

log('INFO', 'Starting WhatsApp client (Baileys)...');
connectToWhatsApp().catch(err => {
    log('ERROR', `Fatal startup error: ${(err as Error).message}`);
    process.exit(1);
});
