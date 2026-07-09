const fs = require('fs');
const path = require('path');

function parseRepairLimit(value) {
    if(value === undefined || value === '' || value === '0') return 0;
    if(!/^[1-9]\d*$/.test(value)) {
        throw new Error('REPAIR_LIMIT must be a positive integer or 0.');
    }
    return Number(value);
}

function parseRepairItemId(value) {
    if(value === undefined || value === '') return null;
    if(!/^[1-9]\d*$/.test(value)) {
        throw new Error('REPAIR_ITEM_ID must be a positive integer.');
    }
    return Number(value);
}

function isHeif(filename) {
    return /\.hei[cf]$/i.test(filename);
}

function indexedTimeMilliseconds(item) {
    const value = Number(item.indexed_time || 0);
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
}

function isRepairCandidate(item, cutoff) {
    return isHeif(item.filename)
        && !item.live_type
        && indexedTimeMilliseconds(item) <= cutoff
        && Number.isInteger(item.additional?.thumbnail?.unit_id);
}

function statePaths(directory, username, serverUrl) {
    const account = Buffer.from(`${username}\0${serverUrl}`).toString('base64url');
    const prefix = path.join(directory, `.repair-images-${account}`);
    return {
        completed: `${prefix}.completed`,
        skipped: `${prefix}.skipped`,
        metadata: `${prefix}.json`,
        inflight: `${prefix}.inflight.json`
    };
}

function readIdSet(file) {
    if(!fs.existsSync(file)) return new Set();
    const ids = fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => /^\d+$/.test(line))
        .map(Number);
    return new Set(ids);
}

function appendId(file, id) {
    const descriptor = fs.openSync(file, 'a', 0o600);
    try {
        fs.writeSync(descriptor, `${id}\n`);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function loadOrCreateMetadata(file, now = Date.now()) {
    if(fs.existsSync(file)) {
        const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
        if(!Number.isInteger(metadata.cutoffIndexedTime)) {
            throw new Error(`Invalid repair metadata in ${file}.`);
        }
        return metadata;
    }
    const metadata = { cutoffIndexedTime: now };
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(metadata), { mode: 0o600 });
    fs.renameSync(temporary, file);
    return metadata;
}

module.exports = {
    appendId,
    indexedTimeMilliseconds,
    isHeif,
    isRepairCandidate,
    loadOrCreateMetadata,
    parseRepairItemId,
    parseRepairLimit,
    readIdSet,
    statePaths
};
