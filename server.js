const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rsvps.json');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml; charset=utf-8',
};

const ensureDataFile = async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    try {
        await fsp.access(DATA_FILE, fs.constants.F_OK);
    } catch (err) {
        await fsp.writeFile(DATA_FILE, '[]\n', 'utf8');
    }
};

const readJsonFile = async () => {
    try {
        const raw = await fsp.readFile(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('Failed to read RSVP data', err);
        return [];
    }
};

const writeJsonFile = async (entries) => {
    const payload = JSON.stringify(entries, null, 2);
    await fsp.writeFile(DATA_FILE, `${payload}\n`, 'utf8');
};

const readRequestBody = (req) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });

const normalizeContributions = (value) => {
    if (Array.isArray(value)) {
        return value
            .map((item) => (typeof item === 'string' ? item : String(item ?? '')))
            .map((item) => item.trim())
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
};

const sanitizePayload = (payload) => {
    const guestName = typeof payload.guestName === 'string' ? payload.guestName.trim() : '';
    if (!guestName) {
        return { error: 'Guest name is required.' };
    }

    const guestCountNumber = Number.parseInt(payload.guestCount, 10);
    const guestCount = Number.isFinite(guestCountNumber) && guestCountNumber > 0 ? guestCountNumber : 1;

    const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
    const contributions = normalizeContributions(payload.contributions);

    if (!contributions.length) {
        return { error: 'At least one contribution is required.' };
    }

    return {
        guestName,
        guestCount,
        notes,
        contributions,
    };
};

const sendJson = (res, statusCode, data) => {
    if (statusCode === 204 || data === null || typeof data === 'undefined') {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
        });
        res.end();
        return;
    }

    const payload = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
};

const handleApiRequest = async (req, res, pathname) => {
    if (pathname === '/api/rsvps') {
        if (req.method === 'GET') {
            const entries = await readJsonFile();
            sendJson(res, 200, entries);
            return true;
        }

        if (req.method === 'POST') {
            try {
                const bodyText = await readRequestBody(req);
                const payload = bodyText ? JSON.parse(bodyText) : {};
                const sanitized = sanitizePayload(payload);

                if (sanitized.error) {
                    sendJson(res, 400, { message: sanitized.error });
                    return true;
                }

                const entries = await readJsonFile();
                const timestamp = Date.now();
                const newEntry = {
                    ...sanitized,
                    id: `${timestamp}-${Math.random().toString(16).slice(2)}`,
                    createdAt: timestamp,
                };
                entries.push(newEntry);
                await writeJsonFile(entries);
                sendJson(res, 201, newEntry);
                return true;
            } catch (err) {
                console.error('Failed to create RSVP', err);
                sendJson(res, 500, { message: 'Unable to create RSVP entry.' });
                return true;
            }
        }

        sendJson(res, 405, { message: 'Method not allowed.' });
        return true;
    }

    const match = pathname.match(/^\/api\/rsvps\/([^/]+)$/);
    if (!match) {
        return false;
    }

    const id = match[1];
    if (req.method === 'PUT') {
        try {
            const bodyText = await readRequestBody(req);
            const payload = bodyText ? JSON.parse(bodyText) : {};
            const sanitized = sanitizePayload(payload);

            if (sanitized.error) {
                sendJson(res, 400, { message: sanitized.error });
                return true;
            }

            const entries = await readJsonFile();
            const index = entries.findIndex((entry) => entry.id === id);
            if (index === -1) {
                sendJson(res, 404, { message: 'RSVP entry not found.' });
                return true;
            }

            const updatedEntry = {
                ...entries[index],
                ...sanitized,
                updatedAt: Date.now(),
            };
            entries[index] = updatedEntry;
            await writeJsonFile(entries);
            sendJson(res, 200, updatedEntry);
            return true;
        } catch (err) {
            console.error('Failed to update RSVP', err);
            sendJson(res, 500, { message: 'Unable to update RSVP entry.' });
            return true;
        }
    }

    if (req.method === 'DELETE') {
        try {
            const entries = await readJsonFile();
            const filtered = entries.filter((entry) => entry.id !== id);
            if (filtered.length === entries.length) {
                sendJson(res, 404, { message: 'RSVP entry not found.' });
                return true;
            }

            await writeJsonFile(filtered);
            sendJson(res, 204, null);
            return true;
        } catch (err) {
            console.error('Failed to delete RSVP', err);
            sendJson(res, 500, { message: 'Unable to delete RSVP entry.' });
            return true;
        }
    }

    sendJson(res, 405, { message: 'Method not allowed.' });
    return true;
};

const serveStaticAsset = (res, pathname) => {
    const safePath = path.normalize(path.join(ROOT_DIR, pathname));
    if (!safePath.startsWith(ROOT_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Access denied');
        return;
    }

    let filePath = safePath;
    fs.stat(filePath, (statErr, stats) => {
        if (!statErr && stats.isDirectory()) {
            filePath = path.join(filePath, 'index.html');
        } else if (statErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }

        fs.readFile(filePath, (readErr, content) => {
            if (readErr) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not found');
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const type = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type });
            res.end(content);
        });
    });
};

const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname;

    if (pathname.startsWith('/api/')) {
        const handled = await handleApiRequest(req, res, pathname);
        if (handled) {
            return;
        }
    }

    const targetPath = pathname === '/' ? '/index.html' : pathname;
    serveStaticAsset(res, targetPath);
});

ensureDataFile()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`RSVP server running at http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('Unable to start server', err);
        process.exit(1);
    });
