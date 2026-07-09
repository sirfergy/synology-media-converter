const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    appendId,
    isRepairCandidate,
    loadOrCreateMetadata,
    parseRepairItemId,
    parseRepairLimit,
    readIdSet,
    statePaths
} = require('../repair-utils');

test('parseRepairLimit accepts unlimited and positive limits', () => {
    assert.equal(parseRepairLimit(undefined), 0);
    assert.equal(parseRepairLimit('0'), 0);
    assert.equal(parseRepairLimit('25'), 25);
    assert.throws(() => parseRepairLimit('-1'));
    assert.throws(() => parseRepairLimit('1.5'));
});

test('parseRepairItemId accepts an optional positive id', () => {
    assert.equal(parseRepairItemId(undefined), null);
    assert.equal(parseRepairItemId('42'), 42);
    assert.throws(() => parseRepairItemId('0'));
    assert.throws(() => parseRepairItemId('-1'));
});

test('isRepairCandidate filters by extension, cutoff, and unit id', () => {
    const item = {
        filename: 'IMG_0001.HEIC',
        indexed_time: 1_700_000_000_000,
        additional: { thumbnail: { unit_id: 42 } }
    };
    assert.equal(isRepairCandidate(item, 1_800_000_000_000), true);
    assert.equal(isRepairCandidate({...item, filename: 'IMG_0001.JPG'}, 1_800_000_000_000), false);
    assert.equal(isRepairCandidate({...item, live_type: 'photo'}, 1_800_000_000_000), false);
    assert.equal(isRepairCandidate(item, 1_600_000_000_000), false);
    assert.equal(isRepairCandidate({...item, additional: {}}, 1_800_000_000_000), false);
});

test('state paths are filesystem-safe and account-specific', () => {
    const first = statePaths('/state', 'user', 'https://first.example.com');
    const second = statePaths('/state', 'user', 'https://second.example.com');
    assert.notEqual(first.completed, second.completed);
    assert.match(first.completed, /^\/state\/\.repair-images-[A-Za-z0-9_-]+\.completed$/);
});

test('completed ids and metadata persist safely', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-utils-'));
    try {
        const ids = path.join(directory, 'completed');
        appendId(ids, 10);
        appendId(ids, 20);
        fs.appendFileSync(ids, 'truncated-value');
        assert.deepEqual([...readIdSet(ids)], [10, 20]);

        const metadata = path.join(directory, 'metadata.json');
        assert.deepEqual(loadOrCreateMetadata(metadata, 1234), { cutoffIndexedTime: 1234 });
        assert.deepEqual(loadOrCreateMetadata(metadata, 9999), { cutoffIndexedTime: 1234 });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
