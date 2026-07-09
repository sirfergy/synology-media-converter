const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const childProcess = require('child_process');
const axios = require('axios');
const config = require('./config.json');
const {
    appendId,
    isRepairCandidate,
    loadOrCreateMetadata,
    parseRepairItemId,
    parseRepairLimit,
    readIdSet,
    statePaths
} = require('./repair-utils');

const repairMode = process.argv.includes('--repair-images');
const tmpDirectory = '/app/tmp';

async function login(account) {
    const session = { url: account.url };
    let res = await fetch(account.url+'/webapi/entry.cgi', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            api: 'SYNO.API.Auth',
            version: 7,
            method: 'login',
            enable_syno_token: 'yes',
            enable_device_token: 'yes',
            format: 'sid',
            device_name: 'SynologyMediaConverter',
            device_id: account.deviceId || '',
            account: account.username,
            passwd: account.password,
            otp_code: account.otpCode || ''
        })
    });
    res = await res.json();
    if(!res.success) {
        if(res.error.code == 403) {
            session.requireOtp = true;
            return session;
        } else {
            throw new Error('Authentication failed with error '+JSON.stringify(res.error));
        }
    }

    session.did = res.data.device_id;
    session.sid = res.data.sid;
    session.synoToken = res.data.synotoken;
    return session;
}

async function checkConversionNeeded(session) {
    let res = await fetch(session.url+'/webapi/entry.cgi', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Syno-Token': session.synoToken,
            'Cookie': `did=${session.did}; id=${session.sid}`
        },
        body: new URLSearchParams({
            api: 'SYNO.Foto.Upload.ConvertedFile',
            version: 3,
            method: 'list_convert_needed',
            type: '["photo","video","live_video"]',
            preset: 'windows'
        })
    });
    res = await res.json();
    if(!res.success) throw new Error('Requesting conversion needed failed with error '+JSON.stringify(res.error));
    return res.data.list;
}

function sessionHeaders(session) {
    return {
        'X-Syno-Token': session.synoToken,
        'Cookie': `did=${session.did}; id=${session.sid}`
    };
}

async function callFotoApi(session, api, method, params = {}) {
    let res = await fetch(session.url+'/webapi/entry.cgi', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...sessionHeaders(session)
        },
        body: new URLSearchParams({
            api,
            version: 1,
            method,
            ...params
        })
    });
    res = await res.json();
    if(!res.success) {
        throw new Error(`${api}.${method} failed with error ${JSON.stringify(res.error)}`);
    }
    return res.data;
}

async function listRepairCandidates(session, cutoff) {
    const pageSize = 500;
    let offset = 0;
    const candidates = [];
    while(true) {
        const data = await callFotoApi(session, 'SYNO.Foto.Browse.Item', 'list', {
            offset: String(offset),
            limit: String(pageSize),
            type: 'photo',
            additional: '["thumbnail","resolution","orientation"]'
        });
        const items = data.list || [];
        for(const item of items) {
            if(isRepairCandidate(item, cutoff)) {
                candidates.push({
                    itemId: item.id,
                    unitId: item.additional.thumbnail.unit_id,
                    filename: item.filename,
                    indexedTime: item.indexed_time
                });
            }
        }
        offset += items.length;
        if(items.length < pageSize) break;
    }
    return candidates.sort((first, second) => first.itemId - second.itemId);
}

function writeJsonDurably(file, value) {
    const temporary = `${file}.tmp`;
    const descriptor = fs.openSync(temporary, 'w', 0o600);
    try {
        fs.writeSync(descriptor, JSON.stringify(value));
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
}

async function restoreRegenerating(session, unitIds) {
    if(unitIds.length === 0) return;
    await callFotoApi(session, 'SYNO.Foto.RegeneratePreview', 'restore_from_regenerating', {
        unit_id: JSON.stringify(unitIds)
    });
}

async function restoreQueuedRegenerating(session, unitIds) {
    const data = await callFotoApi(session, 'SYNO.Foto.RegeneratePreview', 'list_regenerating');
    const queued = new Set((data.list || []).map(item => item.unit_id));
    const stranded = unitIds.filter(unitId => queued.has(unitId));
    await restoreRegenerating(session, stranded);
}

async function recoverInflightRepair(session, inflightFile) {
    if(!fs.existsSync(inflightFile)) return;
    const inflight = JSON.parse(fs.readFileSync(inflightFile, 'utf8'));
    const unitIds = Array.isArray(inflight.unitIds) ? inflight.unitIds : [];
    if(unitIds.length > 0) {
        console.log(`Restoring interrupted repair for item ${inflight.itemId}`);
        await restoreQueuedRegenerating(session, unitIds);
    }
    fs.unlinkSync(inflightFile);
}

async function waitForRegenerationClear(session, unitIds) {
    const deadline = Date.now() + 120_000;
    while(Date.now() < deadline) {
        const data = await callFotoApi(session, 'SYNO.Foto.RegeneratePreview', 'list_regenerating');
        const remaining = new Set((data.list || []).map(item => item.unit_id));
        if(unitIds.every(unitId => !remaining.has(unitId))) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Regeneration queue did not clear units ${unitIds.join(', ')}`);
}

async function downloadFile(session, unitId, savePath) {
    let res = await fetch(session.url+'/webapi/entry.cgi?'+new URLSearchParams({
        api: 'SYNO.Foto.Download',
        version: 1,
        method: 'download',
        unit_id: '['+unitId+']'
    }), {
        headers: {
            'X-Syno-Token': session.synoToken,
            'Cookie': `did=${session.did}; id=${session.sid}`
        }
    });
    if((res.headers.get("content-type") || '').includes('json')) {
        res = await res.json();
        if(!res.success) throw new Error(`Download of file ${unitId} failed with error `+JSON.stringify(res.error));
    } else {
        const fileStream = fs.createWriteStream(savePath, { flags: 'w' });
        await finished(Readable.fromWeb(res.body).pipe(fileStream));
    }
}

/*async function uploadFiles(session, unitId, filePaths) {
    // Upload fails due to bug in Fetch API or built in FormData
    const form = new FormData();
    form.set('api', 'SYNO.Foto.Upload.ConvertedFile');
    form.set('version', '3');
    form.set('method', 'upload');
    form.set('unit_id', unitId);
    for(const name in filePaths) {
        const path = filePaths[name];
        form.set(name, fs.createReadStream(path));
    }

    let res = await fetch(session.url+'/webapi/entry.cgi', {
        method: 'POST',
        headers: {
            'X-Syno-Token': session.synoToken,
            'Cookie': `did=${session.did}; id=${session.sid}`
        },
        body: form
    });
    res = await res.json();
    console.log(res)
    if(!res.success) throw new Error(`Upload of file ${unitId} failed with error `+JSON.stringify(res.error));
}*/
async function uploadFiles(session, unitId, filePaths) {
    const form = {
        api: 'SYNO.Foto.Upload.ConvertedFile',
        version: 3,
        method: 'upload',
        unit_id: unitId
    };
    for(const name in filePaths) {
        const path = filePaths[name];
        form[name] = fs.createReadStream(path);
    }
    const res = await axios.postForm(session.url+'/webapi/entry.cgi', form, {
        headers: {
            'X-Syno-Token': session.synoToken,
            'Cookie': `did=${session.did}; id=${session.sid}`
        }
    });
    if(!res.data.success) throw new Error(`Upload of file ${unitId} failed with error `+JSON.stringify(res.data.error));
}

async function setBroken(session, unitId) {
    if(process.env.EXIT_ON_FAIL == 'true') {
        throw new Error('Exit on broken file is enabled.');
    }

    let res = await fetch(session.url+'/webapi/entry.cgi?'+new URLSearchParams({
        api: 'SYNO.Foto.Upload.ConvertedFile',
        version: 3,
        method: 'set_broken',
        id: '['+unitId+']',
        type: '["photo","video"]' // TODO: only set affacted types broken
    }), {
        headers: {
            'X-Syno-Token': session.synoToken,
            'Cookie': `did=${session.did}; id=${session.sid}`
        }
    });
    res = await res.json();
    if(!res.success) throw new Error(`Marking file ${unitId} as broken failed with error `+JSON.stringify(res.error));
}

function executeCommand(cmd, args) {
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn(cmd, args);
        //console.log(cmd, args.join(' '));

        let buffer = '', errbuffer = '';
        proc.stdout.on('data', data => buffer += data);
        proc.stderr.on('data', data => errbuffer += data);

        proc.on('close', code => {
            if(code != 0) {
                reject(new Error(errbuffer.trim()));
                return;
            }
            resolve(buffer);
        });
        proc.on('error', err => reject(new Error(err)));
    });
}

async function processVideo(srcPath, needThumbnails, needVideo) {
    // Sizes (fit short edge): SM 240    M 320    XL 1280    H264 720
    let dimensions = await executeCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'flat', srcPath]);
    dimensions = {
        width: dimensions.match(/width=(.+)/)[1],
        height: dimensions.match(/height=(.+)/)[1],
        rotation: dimensions.match(/rotation=(.+)/)?.[1],
    };
    if(dimensions.rotation == '90' || dimensions.rotation == '-90') {
        [dimensions.width, dimensions.height] = [dimensions.height, dimensions.width];
        delete dimensions.rotation;
    }
    const landscape = dimensions.width > dimensions.height;

    let thumbs = {};
    if(needVideo) thumbs['film_h264'] = 720;
    if(needThumbnails) {
        thumbs['thumb_sm'] = 240;
        thumbs['thumb_m'] = 320;
        thumbs['thumb_xl'] = 1280;
    }
    for(const thumbType in thumbs) {
        const maxSize = thumbs[thumbType];
        const scale = landscape ? `'-2:min(${maxSize},ih)'` : `'min(${maxSize},iw):-2'`;
        let newPath = srcPath.replace(/\..+$/, '')+'-'+thumbType;
        
        if(thumbType != 'film_h264') {
            newPath += '.jpg';
            await executeCommand('ffmpeg', ['-v', 'error', '-y', '-i', srcPath, '-filter:v', 'thumbnail,scale='+scale, '-frames:v', '1', newPath]);
        } else {
            newPath += '.mp4';
            if(process.env.USE_VAAPI == 'true') {
                await executeCommand('ffmpeg', ['-v', 'error', '-y', '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-i', srcPath, '-filter:v', 'scale_vaapi='+scale, '-c:v', 'h264_vaapi', '-preset', 'slow', newPath]);
            } else {
                await executeCommand('ffmpeg', ['-v', 'error', '-y', '-i', srcPath, '-filter:v', 'scale='+scale, '-c:v', 'h264', '-preset', 'slow', newPath]);
            }
        }
        thumbs[thumbType] = newPath;
    }
    return thumbs;
}

async function processImage(srcPath) {
    let thumbs = {
        thumb_sm: 240,
        thumb_m: 320,
        thumb_xl: 1280
    };

    for(const thumbType in thumbs) {
        const maxSize = thumbs[thumbType];
        let newPath = srcPath.replace(/\..+$/, '')+'-'+thumbType+'.jpg';
        await executeCommand('magick', [srcPath, '-auto-orient', '-resize', `${maxSize}x${maxSize}^>`, '+profile', 'exif', newPath]);
        thumbs[thumbType] = newPath;
    }
    return thumbs;
}

function assertRepairStateMounted() {
    const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    const mounted = mountInfo.split('\n').some(line => line.split(' ')[4] === tmpDirectory);
    if(!mounted) {
        throw new Error(`${tmpDirectory} must be a persistent mount before running repair mode.`);
    }
}

async function repairCandidate(session, candidate, files) {
    await recoverInflightRepair(session, files.inflight);
    const directory = path.join(tmpDirectory, `repair-${candidate.itemId}`);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });

    let unitIds = [candidate.unitId];
    let regenerating = false;
    try {
        const source = path.join(directory, path.basename(candidate.filename));
        await downloadFile(session, candidate.unitId, source);
        const thumbnails = await processImage(source);

        writeJsonDurably(files.inflight, { itemId: candidate.itemId, unitIds });
        const state = await callFotoApi(
            session,
            'SYNO.Foto.RegeneratePreview',
            'set_regenerating',
            { item_id: JSON.stringify([candidate.itemId]) }
        );
        const tasks = state.list || [];
        regenerating = true;
        if(tasks.length === 0) {
            throw new Error(`Regeneration queue returned no units for item ${candidate.itemId}`);
        }
        unitIds = tasks.map(task => task.unit_id);
        writeJsonDurably(files.inflight, { itemId: candidate.itemId, unitIds });

        if(tasks.length !== 1 || tasks[0].type !== 'photo') {
            await restoreRegenerating(session, unitIds);
            regenerating = false;
            fs.unlinkSync(files.inflight);
            appendId(files.skipped, candidate.itemId);
            return 'skipped';
        }

        await uploadFiles(session, tasks[0].unit_id, thumbnails);
        await waitForRegenerationClear(session, unitIds);
        regenerating = false;
        fs.unlinkSync(files.inflight);
        appendId(files.completed, candidate.itemId);
        return 'completed';
    } catch(error) {
        try {
            if(regenerating || fs.existsSync(files.inflight)) {
                await restoreQueuedRegenerating(session, unitIds);
                fs.rmSync(files.inflight, { force: true });
            }
        } catch(restoreError) {
            throw new Error(`${error.message}; restoring regeneration state failed: ${restoreError.message}`);
        }
        throw error;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function repairImages(session, account, remainingLimit, repairItemId) {
    const files = statePaths(tmpDirectory, account.username, account.url);
    await recoverInflightRepair(session, files.inflight);
    const metadata = loadOrCreateMetadata(files.metadata);
    const completed = readIdSet(files.completed);
    const skipped = readIdSet(files.skipped);
    const candidates = await listRepairCandidates(session, metadata.cutoffIndexedTime);
    const pending = candidates.filter(candidate =>
        !completed.has(candidate.itemId) && !skipped.has(candidate.itemId)
    ).filter(candidate => repairItemId === null || candidate.itemId === repairItemId);
    const selected = remainingLimit === 0 ? pending : pending.slice(0, remainingLimit);
    const summary = {
        discovered: candidates.length,
        previouslyCompleted: completed.size,
        previouslySkipped: skipped.size,
        attempted: 0,
        completed: 0,
        skipped: 0,
        failed: 0
    };
    let consecutiveFailures = 0;

    console.log(
        `Repair candidates for ${account.username}: ${candidates.length}; `
        + `pending: ${pending.length}; selected: ${selected.length}`
    );

    for(const candidate of selected) {
        summary.attempted++;
        console.log(
            `Repairing "${candidate.filename}" (${candidate.itemId}) `
            + `${summary.attempted}/${selected.length}`
        );
        try {
            const result = await repairCandidate(session, candidate, files);
            summary[result]++;
            consecutiveFailures = 0;
        } catch(error) {
            summary.failed++;
            consecutiveFailures++;
            console.error(`Repair failed for "${candidate.filename}" (${candidate.itemId}):`, error);
            if(process.env.EXIT_ON_FAIL == 'true' || consecutiveFailures >= 5) {
                throw error;
            }
        }
    }

    console.log(`Repair summary for ${account.username}: ${JSON.stringify(summary)}`);
    return summary;
}

async function cleanupFiles(filePaths) {
    for(const path of Object.values(filePaths)) {
        await fs.promises.unlink(path);
    }
}

function cleanupTemporaryFiles() {
    const preserved = /^(converter\.lock|\.repair-images-)/;
    const files = fs.readdirSync(tmpDirectory);
    files.forEach(file => {
        if(!preserved.test(file)) {
            fs.rmSync(path.join(tmpDirectory, file), { recursive: true, force: true });
        }
    });
}

function readLine(prompt) {
    return new Promise(resolve => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(prompt, text => {
            rl.close();
            resolve(text);
        });
    });
}


(async () => {
    if(!fs.existsSync('tmp')) {
        fs.mkdirSync('tmp');
    }

    try {
        if(repairMode) assertRepairStateMounted();
        const repairLimit = repairMode ? parseRepairLimit(process.env.REPAIR_LIMIT) : 0;
        const repairItemId = repairMode ? parseRepairItemId(process.env.REPAIR_ITEM_ID) : null;
        let remainingLimit = repairLimit;

        for(const account of config.accounts) {
            console.log(`Logging in as ${account.username} on ${account.url}`);
            let session = await login(account);
            if(session.requireOtp) {
                account.otpCode = await readLine('Account requires 2FA, please enter OTP code: ');
                session = await login(account);
                delete account.otpCode;
            }
            if(!account.deviceId) {
                account.deviceId = session.did;
                fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
            }

            if(repairMode) {
                const summary = await repairImages(session, account, remainingLimit, repairItemId);
                if(repairLimit > 0) {
                    remainingLimit -= summary.attempted;
                    if(remainingLimit <= 0) break;
                }
                continue;
            }

            checkLoop: while(true) {
                console.log('Checking if conversion is needed');
                const conversionNeeded = await checkConversionNeeded(session);
                if(conversionNeeded.length == 0) {
                    console.log('Finished, no files for conversion left');
                    break;
                }
                
                for(const fileInfo of conversionNeeded) {
                    try {
                        console.log(`Converting file "${fileInfo.filename}" (${fileInfo.unit_id})`);
                        const srcPath = 'tmp/'+fileInfo.filename;
                        let filePaths = {};
                        
                        await downloadFile(session, fileInfo.unit_id, srcPath);
                        try {
                            switch(fileInfo.type) {
                                case 0:
                                    filePaths = await processImage(srcPath);
                                    break;
                                case 1:
                                    filePaths = await processVideo(srcPath, fileInfo.need_thumbnail, fileInfo.need_video);
                                    break;
                            }
                        } catch(err) {
                            console.error('Marking file as broken:', err);
                            await setBroken(session, fileInfo.unit_id);
                            continue;
                        }
                        await uploadFiles(session, fileInfo.unit_id, filePaths);
                        filePaths['src'] = srcPath;
                        await cleanupFiles(filePaths);
                    } catch(err) {
                        console.error(err);
                        break checkLoop;
                    }
                }
            }
        }
    } catch(err) {
        console.error(err);
        process.exitCode = 1;
    } finally {
        cleanupTemporaryFiles();
    }
})();
