const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

// If a persistent volume is attached (Railway sets RAILWAY_VOLUME_MOUNT_PATH),
// store the database there so data survives redeploys. Otherwise fall back
// to a local folder next to the app (fine for local testing).
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;

const adapter = new FileSync(path.join(DATA_DIR, 'db.json'));
const db = low(adapter);

db.defaults({ users: [], topics: [], messages: [], dms: [], conversations: [], chatMessages: [], attachments: [], halls: [], resetTokens: [], adminMessages: [], meta: {} }).write();

module.exports = db;