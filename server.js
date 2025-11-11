const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'rsvps.db');
const SQLITE_BIN = 'sqlite3';

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

const initializeDatabase = async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    runSqlite(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS rsvps (
            id TEXT PRIMARY KEY,
            guestName TEXT NOT NULL,
            guestCount INTEGER NOT NULL,
            notes TEXT,
            contributions TEXT NOT NULL,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER
        );
    `);
};

const runSqlite = (sql, { json = false } = {}) => {
    const trimmed = sql.trim();
    if (!trimmed) {
        return '';
    }

    const args = json ? ['-json', DB_FILE] : [DB_FILE];
    const result = spawnSync(SQLITE_BIN, args, {
        input: `${trimmed}\n`,
        encoding: 'utf8',
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const message = result.stderr ? result.stderr.trim() : `sqlite3 exited with code ${result.status}`;
        throw new Error(message);
    }

    return result.stdout || '';
};

const parseStoredContributions = (value) => {
    if (!value) {
        return [];
    }

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('Failed to parse stored contributions', err);
        return [];
    }
};

const mapRowToEntry = (row) => {
    const entry = {
        id: row.id,
        guestName: row.guestName,
        guestCount: row.guestCount,
        notes: row.notes || '',
        contributions: parseStoredContributions(row.contributions),
        createdAt: row.createdAt,
    };

    if (row.updatedAt) {
        entry.updatedAt = row.updatedAt;
    }

    return entry;
};

const escapeSqlString = (value) => value.replace(/'/g, "''");

const toSqlString = (value) => `'${escapeSqlString(value)}'`;

const queryAll = (sql) => {
    const output = runSqlite(sql, { json: true }).trim();
    if (!output) {
        return [];
    }

    try {
        return JSON.parse(output);
    } catch (err) {
        throw new Error(`Failed to parse sqlite output: ${err.message}`);
    }
};

const queryOne = (sql) => {
    const [row] = queryAll(sql);
    return row;
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

const applyCorsHeaders = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    applyCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        sendJson(res, 204, null);
        return true;
    }

    if (pathname === '/api/rsvps') {
        if (req.method === 'GET') {
            try {
                const rows = queryAll(
                    `SELECT id, guestName, guestCount, notes, contributions, createdAt, updatedAt
                     FROM rsvps
                     ORDER BY createdAt ASC;`
                );
                const entries = rows.map(mapRowToEntry);
                sendJson(res, 200, entries);
            } catch (err) {
                console.error('Failed to load RSVPs', err);
                sendJson(res, 500, { message: 'Unable to load RSVP entries.' });
            }
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

                const timestamp = Date.now();
                const newEntry = {
                    ...sanitized,
                    id: `${timestamp}-${Math.random().toString(16).slice(2)}`,
                    createdAt: timestamp,
                };
                runSqlite(
                    `INSERT INTO rsvps (id, guestName, guestCount, notes, contributions, createdAt)
                     VALUES (${toSqlString(newEntry.id)}, ${toSqlString(newEntry.guestName)}, ${newEntry.guestCount}, ${toSqlString(newEntry.notes)}, ${toSqlString(JSON.stringify(newEntry.contributions))}, ${newEntry.createdAt});`
                );
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

            const existing = queryOne(
                `SELECT id, guestName, guestCount, notes, contributions, createdAt, updatedAt
                 FROM rsvps WHERE id = ${toSqlString(id)};`
            );
            if (!existing) {
                sendJson(res, 404, { message: 'RSVP entry not found.' });
                return true;
            }

            const updatedEntry = {
                ...sanitized,
                updatedAt: Date.now(),
                createdAt: existing.createdAt,
                id: existing.id,
            };
            runSqlite(
                `UPDATE rsvps
                 SET guestName = ${toSqlString(updatedEntry.guestName)},
                     guestCount = ${updatedEntry.guestCount},
                     notes = ${toSqlString(updatedEntry.notes)},
                     contributions = ${toSqlString(JSON.stringify(updatedEntry.contributions))},
                     updatedAt = ${updatedEntry.updatedAt}
                 WHERE id = ${toSqlString(id)};`
            );
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
            const [{ changes = 0 } = {}] = queryAll(
                `DELETE FROM rsvps WHERE id = ${toSqlString(id)};
                 SELECT changes() AS changes;`
            );
            if (changes === 0) {
                sendJson(res, 404, { message: 'RSVP entry not found.' });
                return true;
            }

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

initializeDatabase()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`RSVP server running at http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('Unable to start server', err);
        process.exit(1);
    });
