const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    isJidGroup,
    isJidNewsletter
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.resolve('./config.json');
const DB_PATH     = path.resolve('./database/banned.json');

let config = { owner: [], prefix: '/' };
let banned = { links: [], names: [], owners: [] };

function loadConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
        catch { /* pakai default */ }
    }
}

function loadDB() {
    if (!fs.existsSync('./database')) fs.mkdirSync('./database', { recursive: true });
    if (fs.existsSync(DB_PATH)) {
        try { banned = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
        catch { /* pakai default */ }
    }
}

function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
function saveDB()     { fs.writeFileSync(DB_PATH,     JSON.stringify(banned, null, 2)); }

loadConfig();
loadDB();

// ─── HELPERS ───────────────────────────────────────────────────────────────────
const CHANNEL_LINK_REGEX = /https?:\/\/(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]+/gi;

/**
 * Ekstrak semua teks dari message object secara rekursif.
 */
function extractText(msg) {
    if (!msg?.message) return '';
    const m = msg.message;
    return (
        m?.conversation                          ||
        m?.extendedTextMessage?.text             ||
        m?.imageMessage?.caption                 ||
        m?.videoMessage?.caption                 ||
        m?.documentMessage?.caption              ||
        m?.buttonsMessage?.contentText           ||
        m?.listMessage?.description              ||
        ''
    );
}

/**
 * Ambil contextInfo dari pesan (untuk deteksi forward dari newsletter).
 */
function getContextInfo(msg) {
    const m = msg?.message;
    if (!m) return null;
    return (
        m?.extendedTextMessage?.contextInfo     ||
        m?.imageMessage?.contextInfo            ||
        m?.videoMessage?.contextInfo            ||
        m?.documentMessage?.contextInfo         ||
        null
    );
}

/**
 * Cek apakah pesan mengandung konten saluran yang dibanned.
 * Return: { matched: true, reason, value } atau { matched: false }
 */
function detectBanned(msg) {
    const text        = extractText(msg);
    const ctxInfo     = getContextInfo(msg);
    const lowerText   = text.toLowerCase();

    // 1. Cek forward dari newsletter JID
    const srcJid = ctxInfo?.remoteJid || '';
    if (isJidNewsletter(srcJid)) {
        // Cek apakah owner newsletter ada di banned.owners
        const ownerNum = srcJid.replace('@newsletter', '').replace(/[^0-9]/g, '');
        if (banned.owners.includes(ownerNum)) {
            return { matched: true, reason: 'owner', value: ownerNum };
        }
        // Tandai sebagai channel forward (meski tidak spesifik di-ban, bisa di-ban semua newsletter)
        // Hanya block kalau memang ada di list
    }

    // 2. Cek link saluran dalam teks
    const foundLinks = text.match(CHANNEL_LINK_REGEX) || [];
    for (const foundLink of foundLinks) {
        const cleanFound = foundLink.replace(/https?:\/\/(www\.)?whatsapp\.com\/channel\//i, '').toLowerCase();
        for (const bannedLink of banned.links) {
            const cleanBanned = bannedLink.replace(/https?:\/\/(www\.)?whatsapp\.com\/channel\//i, '').toLowerCase();
            if (cleanFound.includes(cleanBanned) || cleanBanned.includes(cleanFound)) {
                return { matched: true, reason: 'link', value: bannedLink };
            }
        }
    }

    // 3. Cek nama saluran dalam teks
    for (const name of banned.names) {
        if (lowerText.includes(name.toLowerCase())) {
            return { matched: true, reason: 'name', value: name };
        }
    }

    // 4. Cek newsletter invite message
    const inviteMsg = msg?.message?.newsletterAdminInviteMessage;
    if (inviteMsg) {
        const inviteName = inviteMsg.newsletterName?.toLowerCase() || '';
        for (const name of banned.names) {
            if (inviteName.includes(name.toLowerCase())) {
                return { matched: true, reason: 'name', value: name };
            }
        }
    }

    return { matched: false };
}

function isOwner(num) {
    return config.owner.includes(num.replace(/[^0-9]/g, ''));
}

function cleanNum(raw) {
    return raw.replace(/[^0-9]/g, '');
}

// ─── REPLY HELPER ──────────────────────────────────────────────────────────────
async function reply(sock, jid, text, quoted) {
    await sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
}

// ─── COMMAND HANDLER ───────────────────────────────────────────────────────────
async function handleCommand(sock, msg, from, senderNum, text) {
    const args    = text.slice(config.prefix.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    const ownerOk = isOwner(senderNum);

    switch (command) {

        // ── /addban ──────────────────────────────────────────────────────────────
        case 'addban': {
            if (!ownerOk) return reply(sock, from, '⛔ Hanya owner yang bisa menggunakan perintah ini.', msg);

            const type  = args[0]?.toLowerCase();
            const value = args.slice(1).join(' ').trim();

            if (!type || !value) {
                return reply(sock, from,
                    `❌ Format salah.\n\n` +
                    `${config.prefix}addban link [url saluran]\n` +
                    `${config.prefix}addban name [nama saluran]\n` +
                    `${config.prefix}addban owner [nomor owner]`,
                    msg
                );
            }

            if (type === 'link') {
                if (banned.links.includes(value)) {
                    return reply(sock, from, '⚠️ Link ini sudah ada di daftar ban.', msg);
                }
                banned.links.push(value);
                saveDB();
                return reply(sock, from, `✅ *Link saluran dibanned:*\n${value}`, msg);
            }

            if (type === 'name') {
                if (banned.names.includes(value)) {
                    return reply(sock, from, '⚠️ Nama ini sudah ada di daftar ban.', msg);
                }
                banned.names.push(value);
                saveDB();
                return reply(sock, from, `✅ *Nama saluran dibanned:*\n${value}`, msg);
            }

            if (type === 'owner') {
                const num = cleanNum(value);
                if (!num) return reply(sock, from, '❌ Nomor tidak valid.', msg);
                if (banned.owners.includes(num)) {
                    return reply(sock, from, '⚠️ Nomor owner ini sudah ada di daftar ban.', msg);
                }
                banned.owners.push(num);
                saveDB();
                return reply(sock, from, `✅ *Owner saluran dibanned:*\n${num}`, msg);
            }

            return reply(sock, from, '❌ Tipe tidak valid. Gunakan: `link`, `name`, atau `owner`', msg);
        }

        // ── /delban ──────────────────────────────────────────────────────────────
        case 'delban': {
            if (!ownerOk) return reply(sock, from, '⛔ Hanya owner yang bisa menggunakan perintah ini.', msg);

            const type  = args[0]?.toLowerCase();
            const value = args.slice(1).join(' ').trim();

            if (!type || !value) {
                return reply(sock, from,
                    `❌ Format:\n${config.prefix}delban [link/name/owner] [nilai]`,
                    msg
                );
            }

            let removed = false;

            if (type === 'link') {
                const idx = banned.links.indexOf(value);
                if (idx > -1) { banned.links.splice(idx, 1); removed = true; }
            } else if (type === 'name') {
                const idx = banned.names.indexOf(value);
                if (idx > -1) { banned.names.splice(idx, 1); removed = true; }
            } else if (type === 'owner') {
                const num = cleanNum(value);
                const idx = banned.owners.indexOf(num);
                if (idx > -1) { banned.owners.splice(idx, 1); removed = true; }
            }

            if (removed) {
                saveDB();
                return reply(sock, from, `✅ Berhasil dihapus dari daftar ban.`, msg);
            }
            return reply(sock, from, `⚠️ Nilai tidak ditemukan di daftar ban.`, msg);
        }

        // ── /listban ─────────────────────────────────────────────────────────────
        case 'listban': {
            if (!ownerOk) return reply(sock, from, '⛔ Hanya owner yang bisa menggunakan perintah ini.', msg);

            const fmt = (arr, emoji) =>
                arr.length
                    ? arr.map((v, i) => `  ${i + 1}. ${v}`).join('\n')
                    : '  _(kosong)_';

            const text =
                `📋 *Daftar Banned Saluran*\n\n` +
                `🔗 *Link* (${banned.links.length}):\n${fmt(banned.links)}\n\n` +
                `📛 *Nama* (${banned.names.length}):\n${fmt(banned.names)}\n\n` +
                `👤 *Owner* (${banned.owners.length}):\n${fmt(banned.owners)}`;

            return reply(sock, from, text, msg);
        }

        // ── /setowner ────────────────────────────────────────────────────────────
        case 'setowner': {
            // Bisa dipakai siapa saja kalau owner list masih kosong (first setup)
            if (config.owner.length > 0 && !ownerOk) {
                return reply(sock, from, '⛔ Hanya owner yang bisa menggunakan perintah ini.', msg);
            }
            const num = cleanNum(args[0] || '');
            if (!num) return reply(sock, from, `❌ Format: ${config.prefix}setowner [nomor]`, msg);
            if (config.owner.includes(num)) {
                return reply(sock, from, '⚠️ Nomor ini sudah terdaftar sebagai owner.', msg);
            }
            config.owner.push(num);
            saveConfig();
            return reply(sock, from, `✅ Owner ditambahkan: ${num}`, msg);
        }

        // ── /delowner ────────────────────────────────────────────────────────────
        case 'delowner': {
            if (!ownerOk) return reply(sock, from, '⛔ Hanya owner yang bisa menggunakan perintah ini.', msg);
            const num = cleanNum(args[0] || '');
            const idx = config.owner.indexOf(num);
            if (idx > -1) {
                config.owner.splice(idx, 1);
                saveConfig();
                return reply(sock, from, `✅ Owner dihapus: ${num}`, msg);
            }
            return reply(sock, from, `⚠️ Nomor tidak ditemukan sebagai owner.`, msg);
        }

        // ── /setprefix ───────────────────────────────────────────────────────────
        case 'setprefix': {
            if (!ownerOk) return reply(sock, from, '⛔ Hanya owner yang bisa menggunakan perintah ini.', msg);
            const np = args[0];
            if (!np) return reply(sock, from, `❌ Format: ${config.prefix}setprefix [karakter]`, msg);
            config.prefix = np;
            saveConfig();
            return reply(sock, from, `✅ Prefix diubah ke: ${np}`, msg);
        }

        // ── /help ────────────────────────────────────────────────────────────────
        case 'help': {
            const p = config.prefix;
            const helpText =
                `🤖 *BannedSal Bot*\n` +
                `_Auto banned saluran WhatsApp_\n\n` +
                `*━━ BAN MANAGEMENT ━━*\n` +
                `${p}addban link [url]    → Ban by link\n` +
                `${p}addban name [nama]   → Ban by nama\n` +
                `${p}addban owner [no]    → Ban by owner\n` +
                `${p}delban link [url]    → Hapus ban link\n` +
                `${p}delban name [nama]   → Hapus ban nama\n` +
                `${p}delban owner [no]    → Hapus ban owner\n` +
                `${p}listban              → Lihat semua ban\n\n` +
                `*━━ OWNER ━━*\n` +
                `${p}setowner [no]        → Tambah owner\n` +
                `${p}delowner [no]        → Hapus owner\n` +
                `${p}setprefix [karakter] → Ubah prefix\n\n` +
                `*━━ INFO ━━*\n` +
                `${p}help                 → Menu ini\n\n` +
                `_Owner terdaftar: ${config.owner.length} akun_`;
            return reply(sock, from, helpText, msg);
        }

        default:
            // Diam untuk command tidak dikenal
            break;
    }
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function startBot() {
    const { version }            = await fetchLatestBaileysVersion();
    const { state, saveCreds }   = await useMultiFileAuthState('./auth');

    const sock = makeWASocket({
        version,
        auth:              state,
        logger:            pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser:           ['BannedSal', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (connection === 'close') {
            const code    = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const recon   = code !== DisconnectReason.loggedOut;
            console.log(`[BannedSal] Koneksi terputus. Kode: ${code}. Reconnect: ${recon}`);
            if (recon) startBot();
            else {
                console.log('[BannedSal] Logged out. Hapus folder ./auth dan scan ulang.');
                process.exit(0);
            }
        } else if (connection === 'open') {
            console.log('[BannedSal] ✅ Bot terhubung!');
            console.log(`[BannedSal] Owner: ${config.owner.length ? config.owner.join(', ') : 'Belum diset — kirim /setowner [nomormu]'}`);
            console.log(`[BannedSal] Prefix: ${config.prefix}`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const from      = msg.key.remoteJid;
                const isGroup   = isJidGroup(from);
                const sender    = msg.key.participant || msg.key.remoteJid;
                const senderNum = cleanNum(sender);
                const text      = extractText(msg);

                // ── AUTO-BAN DETECTION (hanya di grup) ──────────────────────────
                if (isGroup) {
                    const detection = detectBanned(msg);
                    if (detection.matched) {
                        // Hapus pesan
                        try {
                            await sock.sendMessage(from, { delete: msg.key });
                        } catch { /* mungkin bukan admin */ }

                        await sock.sendMessage(from,
                            {
                                text:
                                    `⛔ *[BannedSal]* Pesan dari saluran terlarang dihapus.\n` +
                                    `┌ Alasan  : ${detection.reason === 'link' ? '🔗 Link' : detection.reason === 'name' ? '📛 Nama' : '👤 Owner'} terlarang\n` +
                                    `└ Nilai   : ${detection.value}`
                            }
                        );
                        continue; // skip command check
                    }
                }

                // ── COMMAND HANDLER ─────────────────────────────────────────────
                if (!text.startsWith(config.prefix)) continue;
                await handleCommand(sock, msg, from, senderNum, text);

            } catch (err) {
                console.error('[BannedSal] Error handle message:', err.message);
            }
        }
    });
}

startBot().catch(err => {
    console.error('[BannedSal] Fatal:', err);
    process.exit(1);
});
