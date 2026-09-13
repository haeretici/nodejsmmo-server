'use strict';

const assert = require('assert');
const { request, withHttp, waitFor } = require('./helpers');
const { encodeFrame, decodeFrame } = require('../src/protocol/frame');
const { C2S, S2C, REASON } = require('../src/protocol/opcodes');
const {
    decodeHello,
    decodeEnterWorld,
    decodePong,
    decodeAppear,
    decodeKick,
    decodeMove,
    decodeReject,
    decodeSkills
} = require('../src/protocol/messages');
const { parseHexToken } = require('../src/security/token');
const { TILE } = require('../src/world/static_map');

function openWs(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    ws.binaryType = 'arraybuffer';
    const inbox = [];
    const closed = { code: null, done: false };
    let openedOk = false;
    const opened = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('open timeout')), 2000);
        ws.addEventListener('open', () => {
            openedOk = true;
            clearTimeout(t);
            resolve();
        });
        ws.addEventListener('error', () => {
            if (!openedOk) {
                clearTimeout(t);
                reject(new Error('ws error'));
            }
        });
    });
    ws.addEventListener('message', (ev) => {
        inbox.push(decodeFrame(Buffer.from(ev.data)));
    });
    ws.addEventListener('close', (ev) => {
        closed.code = ev.code;
        closed.done = true;
    });
    return { ws, inbox, closed, opened };
}

function findOp(inbox, opcode) {
    return inbox.find((f) => f.opcode === opcode) || null;
}

async function bootAccount(port, email, name) {
    const reg = await request(port, {
        method: 'POST',
        path: '/v1/register',
        body: { email, password: 'correct-horse' }
    });
    assert.strictEqual(reg.status, 201, email);
    const cookie = `sid=${reg.sid}`;
    const ch = await request(port, {
        method: 'POST',
        path: '/v1/characters',
        cookie,
        body: { name, vocation: 'scout' }
    });
    assert.strictEqual(ch.status, 201, name);
    const play = await request(port, {
        method: 'POST',
        path: '/v1/play',
        cookie,
        body: { characterId: ch.json.id }
    });
    assert.strictEqual(play.status, 200);
    return { cookie, character: ch.json, token: play.json.token };
}

async function enter(port, token) {
    const c = openWs(port);
    await c.opened;
    await waitFor(() => findOp(c.inbox, S2C.HELLO), 1000);
    c.ws.send(encodeFrame(C2S.ENTER, 1, parseHexToken(token)));
    await waitFor(() => findOp(c.inbox, S2C.ENTER_WORLD) || c.closed.done, 1500);
    return c;
}

async function main() {
    await withHttp(async ({ port, limiter }) => {
        const acc = await bootAccount(port, 'ws@example.com', 'Ash');
        const c = await enter(port, acc.token);
        const hello = decodeHello(findOp(c.inbox, S2C.HELLO).payload);
        assert.strictEqual(hello.ups, 20);
        const ew = findOp(c.inbox, S2C.ENTER_WORLD);
        assert.ok(ew, 'enter world');
        const world = decodeEnterWorld(ew.payload);
        assert.strictEqual(world.name, 'Ash');
        assert.strictEqual(world.x, 12);
        assert.strictEqual(world.y, 12);
        const lx = world.x - world.viewport.originX;
        const ly = world.y - world.viewport.originY;
        assert.strictEqual(world.viewport.tiles[ly * world.viewport.width + lx], TILE.SPAWN);
        await waitFor(() => findOp(c.inbox, S2C.SKILLS) || c.closed.done, 1500);
        const sk = findOp(c.inbox, S2C.SKILLS);
        assert.ok(sk, 'skills');
        const skills = decodeSkills(sk.payload);
        assert.strictEqual(skills.fist, 10);
        assert.strictEqual(skills.magic, 0);
        assert.strictEqual(limiter.metrics.enterOk, 1);

        c.ws.send(encodeFrame(C2S.MOVE_STEP, 2, Buffer.from([0])));
        await waitFor(() => findOp(c.inbox, S2C.MOVE), 800);
        const mv = decodeMove(findOp(c.inbox, S2C.MOVE).payload);
        assert.strictEqual(mv.id, world.characterId);
        assert.strictEqual(mv.x, 12);
        assert.strictEqual(mv.y, 11);
        assert.ok(findOp(c.inbox, S2C.VIEWPORT));

        const ping = Buffer.alloc(4);
        ping.writeUInt32LE(12345, 0);
        c.ws.send(encodeFrame(C2S.PING, 3, ping));
        await waitFor(() => findOp(c.inbox, S2C.PONG), 800);
        const pong = decodePong(findOp(c.inbox, S2C.PONG).payload);
        assert.strictEqual(pong.clientMs, 12345);

        c.ws.send(encodeFrame(C2S.LOGOUT, 4, Buffer.alloc(0)));
        await waitFor(() => c.closed.done, 800);
        assert.strictEqual(c.closed.code, 4000 + REASON.LOGOUT);
    });

    await withHttp(async ({ port }) => {
        const acc = await bootAccount(port, 'reuse@example.com', 'Reuse');
        const c = await enter(port, acc.token);
        assert.ok(findOp(c.inbox, S2C.ENTER_WORLD));
        c.ws.close();
        await waitFor(() => c.closed.done, 800);
        const c2 = await enter(port, acc.token);
        assert.ok(c2.closed.done);
        assert.strictEqual(c2.closed.code, 4000 + REASON.BAD_TOKEN);
        const kick = findOp(c2.inbox, S2C.KICK);
        if (kick) assert.strictEqual(decodeKick(kick.payload), REASON.BAD_TOKEN);
    });

    await withHttp(async ({ port }) => {
        const c = openWs(port);
        await c.opened;
        await waitFor(() => findOp(c.inbox, S2C.HELLO), 1000);
        c.ws.send(encodeFrame(C2S.ENTER, 1, Buffer.alloc(32)));
        await waitFor(() => c.closed.done, 800);
        assert.strictEqual(c.closed.code, 4000 + REASON.BAD_TOKEN);
    });

    await withHttp(async ({ port }) => {
        const c = openWs(port);
        await c.opened;
        await waitFor(() => findOp(c.inbox, S2C.HELLO), 1000);
        c.ws.send('not-binary');
        await waitFor(() => c.closed.done, 800);
        assert.strictEqual(c.closed.code, 4000 + REASON.BAD_FRAME);
    });

    await withHttp(async ({ port }) => {
        const c = openWs(port);
        await c.opened;
        await waitFor(() => c.closed.done, 1000);
        assert.strictEqual(c.closed.code, 4000 + REASON.TIMEOUT);
    }, { limits: { wsEnterTimeoutMs: 80 } });

    await withHttp(async ({ port }) => {
        const acc = await bootAccount(port, 'flood@example.com', 'Flood');
        const c = await enter(port, acc.token);
        assert.ok(findOp(c.inbox, S2C.ENTER_WORLD));
        let seq = 2;
        for (let i = 0; i < 20; i++) {
            c.ws.send(encodeFrame(C2S.PING, seq, Buffer.alloc(4)));
            seq += 1;
        }
        await waitFor(() => c.closed.done, 800);
        assert.strictEqual(c.closed.code, 4000 + REASON.RATE_LIMITED);
    }, { limits: { packetBurst: 4, maxPacketsPerSecond: 1 } });

    await withHttp(async ({ port }) => {
        const acc = await bootAccount(port, 'online@example.com', 'First');
        const c1 = await enter(port, acc.token);
        assert.ok(findOp(c1.inbox, S2C.ENTER_WORLD));
        const ch2 = await request(port, {
            method: 'POST',
            path: '/v1/characters',
            cookie: acc.cookie,
            body: { name: 'Second', vocation: 'guardian' }
        });
        const play2 = await request(port, {
            method: 'POST',
            path: '/v1/play',
            cookie: acc.cookie,
            body: { characterId: ch2.json.id }
        });
        const c2 = await enter(port, play2.json.token);
        assert.ok(c2.closed.done);
        assert.strictEqual(c2.closed.code, 4000 + REASON.ALREADY_ONLINE);
        assert.ok(findOp(c1.inbox, S2C.ENTER_WORLD));
        c1.ws.close();
        await waitFor(() => c1.closed.done, 800);
    });

    await withHttp(async ({ port }) => {
        const a = await bootAccount(port, 'alpha@example.com', 'Alpha');
        const b = await bootAccount(port, 'beta@example.com', 'Beta');
        const wa = await enter(port, a.token);
        const wb = await enter(port, b.token);
        assert.ok(findOp(wa.inbox, S2C.ENTER_WORLD));
        assert.ok(findOp(wb.inbox, S2C.ENTER_WORLD));
        await waitFor(() => findOp(wa.inbox, S2C.APPEAR) && findOp(wb.inbox, S2C.APPEAR), 800);
        const appearA = decodeAppear(findOp(wa.inbox, S2C.APPEAR).payload);
        const appearB = decodeAppear(findOp(wb.inbox, S2C.APPEAR).payload);
        assert.strictEqual(appearA.name, 'Beta');
        assert.strictEqual(appearB.name, 'Alpha');
        wa.ws.send(encodeFrame(C2S.MOVE_STEP, 2, Buffer.from([0])));
        await waitFor(() => findOp(wa.inbox, S2C.MOVE) && findOp(wb.inbox, S2C.MOVE), 800);
        const seen = decodeMove(findOp(wb.inbox, S2C.MOVE).payload);
        assert.strictEqual(seen.id, appearB.id);
        assert.strictEqual(seen.y, 11);

        wa.ws.close();
        await waitFor(() => findOp(wb.inbox, S2C.DISAPPEAR), 800);
        wb.ws.close();
    });

    await withHttp(async ({ port }) => {
        const acc = await bootAccount(port, 'hunt@example.com', 'Hunter');
        const c = await enter(port, acc.token);
        assert.ok(findOp(c.inbox, S2C.ENTER_WORLD));
        const payload = Buffer.alloc(4);
        payload.writeUInt32LE(99, 0);
        c.ws.send(encodeFrame(C2S.SET_TARGET, 2, payload));
        await waitFor(() => findOp(c.inbox, S2C.REJECT), 800);
        const rej = decodeReject(findOp(c.inbox, S2C.REJECT).payload);
        assert.strictEqual(rej.reason, REASON.NO_TARGET);
        c.ws.close();
        await waitFor(() => c.closed.done, 800);
    });

    await withHttp(async ({ port }) => {
        const acc = await bootAccount(port, 'replace@example.com', 'Replace');
        const c1 = await enter(port, acc.token);
        assert.ok(findOp(c1.inbox, S2C.ENTER_WORLD));
        const play2 = await request(port, {
            method: 'POST',
            path: '/v1/play',
            cookie: acc.cookie,
            body: { characterId: acc.character.id }
        });
        const c2 = await enter(port, play2.json.token);
        assert.ok(findOp(c2.inbox, S2C.ENTER_WORLD));
        await waitFor(() => c1.closed.done, 800);
        assert.strictEqual(c1.closed.code, 4000 + REASON.REPLACED);
        c2.ws.close();
        await waitFor(() => c2.closed.done, 800);
    });

    console.log('ok ws_enter');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
