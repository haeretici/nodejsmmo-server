'use strict';

const assert = require('assert');
const WebSocket = require('ws');
const { testSettings, withHttp, waitFor } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, REASON, DIR } = require('../src/protocol/opcodes');
const { encodeFrame, decodeFrame, decodeFrames, measureFramePayload } = require('../src/protocol/frame');
const {
    encodeMove,
    decodeMove,
    encodeStats,
    decodeStats,
    encodeSwing,
    decodeSwing,
    encodeAppear,
    decodeAppear,
    encodeSay,
    decodeSay,
    encodeKick,
    decodeKick,
    encodeViewport,
    decodeViewport,
    encodeContainer,
    decodeContainer,
    encodeInventory,
    decodeInventory,
    encodeEquipment,
    decodeEquipment
} = require('../src/protocol/messages');
const { parseHexToken } = require('../src/security/token');

function mockSocket() {
    let corkDepth = 0;
    const corkHistory = [];
    return {
        readyState: 1,
        sent: [],
        _socket: {
            cork() {
                corkDepth += 1;
                corkHistory.push('cork:' + corkDepth);
            },
            uncork() {
                corkDepth -= 1;
                corkHistory.push('uncork:' + corkDepth);
            },
            getCorkDepth: () => corkDepth,
            getCorkHistory: () => corkHistory
        },
        send(buf) {
            this.sent.push(Buffer.from(buf));
        },
        close() {
            this.readyState = 3;
            this.closed = true;
        },
        terminate() {
            this.readyState = 3;
            this.closed = true;
        }
    };
}

function makeWorld(extra) {
    const settings = testSettings();
    settings.limits = settings.limits || {};
    settings.limits.outboundBatching = true;
    if (extra) Object.assign(settings, extra);
    const store = new MemoryStore();
    const log = createLog(settings);
    const world = new World({
        settings,
        store,
        log,
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return world;
}

function makeSession(world, chId = 1, name = 'Player1', pos = { x: 12, y: 12, z: 0 }) {
    const sock = mockSocket();
    const limiter = new RateLimiter();
    const session = new GameSession({
        socket: sock,
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter,
        log: world.log
    });
    const ch = {
        id: chId,
        accountId: chId,
        name,
        vocation: 'scout',
        level: 1,
        experience: 0,
        hp: 100,
        hpMax: 100,
        mp: 50,
        mpMax: 50,
        townId: 1
    };
    session.bindCharacter(ch, pos);
    world.add(session);
    return session;
}

function testBatchingQueueAccumulation() {
    const sock = mockSocket();
    const session = new GameSession({
        socket: sock,
        ip: '127.0.0.1',
        world: null,
        settings: { limits: { outboundBatching: true } },
        limiter: new RateLimiter(),
        log: createLog({ logLevel: 'silent' })
    });

    // Outside batch mode: send immediately
    session.send(S2C.SAY, encodeSay('Immediate hello'));
    assert.strictEqual(sock.sent.length, 1);
    assert.strictEqual(session.outboundQueue.length, 0);

    // Enable batch mode explicitly on session:
    session.batching = true;
    session.send(S2C.MOVE, encodeMove({ id: 1, x: 10, y: 11, z: 0, dir: 1 }));
    session.send(S2C.STATS, encodeStats({ id: 1, hp: 90, hpMax: 100, mp: 40, mpMax: 50 }));
    session.send(S2C.SWING, encodeSwing({ sourceId: 1, targetId: 2, amount: 10, flags: 0 }));

    // Socket should NOT have received these 3 frames yet:
    assert.strictEqual(sock.sent.length, 1, 'Micro-events must be held in outbound queue');
    assert.strictEqual(session.outboundQueue.length, 3, 'Outbound queue holds 3 frames');

    // Flush the outbound queue:
    const flushed = session.flushOutbound();
    assert.strictEqual(flushed, 3, 'Should flush exactly 3 frames');
    assert.strictEqual(session.outboundQueue.length, 0, 'Queue cleared after flush');
    assert.strictEqual(sock.sent.length, 4, 'All frames delivered to socket');
    assert.strictEqual(session.flushedBatchesCount, 1);
    assert.strictEqual(session.flushedFramesCount, 3);
}

function testWorldStepOutboundBatchingLifecycle() {
    const world = makeWorld();
    const session = makeSession(world, 10, 'Ash', { x: 12, y: 12, z: 0 });
    const sock = session.socket;

    // Clear initial enter packets for a clean baseline:
    sock.sent.length = 0;

    // Queue a MOVE_STEP intent:
    session.intentQueue.push({
        opcode: C2S.MOVE_STEP,
        seq: 1,
        payload: Buffer.from([DIR.S])
    });

    // Execute world.step(1):
    world.step(1);

    // During world.step(), movement generated MOVE, VIEWPORT, etc.
    // They must have been batched and flushed at step completion:
    assert.ok(sock.sent.length >= 2, 'Should receive MOVE and VIEWPORT');
    assert.strictEqual(session.outboundQueue.length, 0, 'Queue must be drained at end of tick');
    assert.strictEqual(world._batchingOutbound, false, 'World batching flag must reset');
    assert.strictEqual(world._dirtyOutboundSessions.size, 0, 'Dirty session set must be cleared');

    // Validate received frames:
    const frames = sock.sent.map((b) => decodeFrame(b));
    const moveFrame = frames.find((f) => f.opcode === S2C.MOVE);
    const vpFrame = frames.find((f) => f.opcode === S2C.VIEWPORT);
    assert.ok(moveFrame, 'Must contain MOVE frame');
    assert.ok(vpFrame, 'Must contain VIEWPORT frame');

    const mv = decodeMove(moveFrame.payload);
    assert.strictEqual(mv.id, session.id);
    assert.strictEqual(mv.y, 13);
}

function testTCPWriteSyscallReductionWithCorking() {
    const sock = mockSocket();
    const session = new GameSession({
        socket: sock,
        ip: '127.0.0.1',
        world: null,
        settings: { limits: { outboundBatching: true } },
        limiter: new RateLimiter(),
        log: createLog({ logLevel: 'silent' })
    });

    session.batching = true;
    for (let i = 0; i < 5; i++) {
        session.send(S2C.MOVE, encodeMove({ id: 1, x: 10 + i, y: 10, z: 0, dir: 0 }));
    }

    assert.strictEqual(sock._socket.getCorkDepth(), 0, 'Not corked before flush');
    assert.strictEqual(session.outboundQueue.length, 5);

    session.flushOutbound();

    // Verify cork was applied around the batch flush:
    const history = sock._socket.getCorkHistory();
    assert.deepStrictEqual(history, ['cork:1', 'uncork:0'], 'Cork and uncork must surround the batch write');
    assert.strictEqual(sock._socket.getCorkDepth(), 0, 'Cork depth must be 0 after flush');
    assert.strictEqual(sock.sent.length, 5);
}

function testDirtySessionScaleInvariant() {
    const world = makeWorld();
    const sessions = [];
    const TOTAL_SESSIONS = 50;

    for (let i = 0; i < TOTAL_SESSIONS; i++) {
        sessions.push(makeSession(world, 100 + i, `Bot_${i}`, { x: 12, y: 12, z: 0 }));
    }

    // Only session 0 and session 5 generate events:
    world._batchingOutbound = true;
    sessions[0].send(S2C.SAY, encodeSay('Event 1'));
    sessions[5].send(S2C.SAY, encodeSay('Event 2'));

    // Check dirty sessions set:
    assert.strictEqual(world._dirtyOutboundSessions.size, 2, 'Only 2 dirty sessions out of 50');
    assert.ok(world._dirtyOutboundSessions.has(sessions[0]));
    assert.ok(world._dirtyOutboundSessions.has(sessions[5]));

    // Flush outbound:
    const totalFlushed = world.flushOutbound();
    assert.strictEqual(totalFlushed, 2);
    assert.strictEqual(world._dirtyOutboundSessions.size, 0);

    // Verify only sessions 0 and 5 had socket sends:
    assert.ok(sessions[0].socket.sent.length > 0);
    assert.ok(sessions[5].socket.sent.length > 0);
    assert.strictEqual(sessions[1].socket.sent.length, 0);
    assert.strictEqual(sessions[2].socket.sent.length, 0);
    world._batchingOutbound = false;
}

function testCoalescePayloadsMode() {
    const sock = mockSocket();
    const session = new GameSession({
        socket: sock,
        ip: '127.0.0.1',
        world: null,
        settings: { limits: { outboundBatching: true, coalescePayloads: true } },
        limiter: new RateLimiter(),
        log: createLog({ logLevel: 'silent' })
    });

    session.batching = true;
    const f1Payload = encodeMove({ id: 42, x: 15, y: 20, z: 0, dir: 2 });
    const f2Payload = encodeStats({ id: 42, hp: 85, hpMax: 100, mp: 30, mpMax: 50 });
    const f3Payload = encodeSwing({ sourceId: 42, targetId: 99, amount: 25, flags: 4 });

    session.send(S2C.MOVE, f1Payload);
    session.send(S2C.STATS, f2Payload);
    session.send(S2C.SWING, f3Payload);

    assert.strictEqual(session.outboundQueue.length, 3);
    assert.strictEqual(sock.sent.length, 0);

    // Flush with coalesce = true:
    const flushed = session.flushOutbound();
    assert.strictEqual(flushed, 3);
    assert.strictEqual(sock.sent.length, 1, 'Coalesced mode must emit exactly 1 WebSocket frame');

    // Decode coalesced payload using decodeFrames:
    const coalescedBuf = sock.sent[0];
    const frames = decodeFrames(coalescedBuf);
    assert.strictEqual(frames.length, 3, 'decodeFrames must recover all 3 batched frames');

    assert.strictEqual(frames[0].opcode, S2C.MOVE);
    assert.strictEqual(frames[0].seq, 1);
    const mv = decodeMove(frames[0].payload);
    assert.strictEqual(mv.id, 42);
    assert.strictEqual(mv.x, 15);
    assert.strictEqual(mv.y, 20);

    assert.strictEqual(frames[1].opcode, S2C.STATS);
    assert.strictEqual(frames[1].seq, 2);
    const st = decodeStats(frames[1].payload);
    assert.strictEqual(st.id, 42);
    assert.strictEqual(st.hp, 85);

    assert.strictEqual(frames[2].opcode, S2C.SWING);
    assert.strictEqual(frames[2].seq, 3);
    const sw = decodeSwing(frames[2].payload);
    assert.strictEqual(sw.sourceId, 42);
    assert.strictEqual(sw.amount, 25);
    assert.strictEqual(sw.flags, 4);
}

function testDecodeFramesMultiFrameParser() {
    const f1 = encodeFrame(S2C.MOVE, 10, encodeMove({ id: 1, x: 2, y: 3, z: 4, dir: 1 }));
    const f2 = encodeFrame(S2C.APPEAR, 11, encodeAppear({ id: 2, name: 'Goblin', x: 5, y: 6, z: 0, hp: 50, hpMax: 50, flags: 0, look: 'goblin' }));
    const f3 = encodeFrame(S2C.SAY, 12, encodeSay('Watch out!'));
    const f4 = encodeFrame(S2C.VIEWPORT, 13, encodeViewport({ originX: 0, originY: 0, z: 0, width: 2, height: 2, tiles: [1, 2, 3, 4] }));
    const f5 = encodeFrame(S2C.CONTAINER, 14, encodeContainer({ id: 500, items: [{ id: 'potion', count: 2 }] }));

    const singleCoalesced = Buffer.concat([f1, f2, f3, f4, f5]);
    const parsed = decodeFrames(singleCoalesced);
    assert.strictEqual(parsed.length, 5);

    assert.strictEqual(parsed[0].opcode, S2C.MOVE);
    assert.strictEqual(parsed[0].seq, 10);
    assert.strictEqual(decodeMove(parsed[0].payload).id, 1);

    assert.strictEqual(parsed[1].opcode, S2C.APPEAR);
    assert.strictEqual(parsed[1].seq, 11);
    assert.strictEqual(decodeAppear(parsed[1].payload).name, 'Goblin');

    assert.strictEqual(parsed[2].opcode, S2C.SAY);
    assert.strictEqual(parsed[2].seq, 12);
    assert.strictEqual(decodeSay(parsed[2].payload).text, 'Watch out!');
    assert.strictEqual(decodeSay(parsed[2].payload).speakerId, 0);

    assert.strictEqual(parsed[3].opcode, S2C.VIEWPORT);
    assert.strictEqual(parsed[3].seq, 13);
    assert.strictEqual(decodeViewport(parsed[3].payload).width, 2);

    assert.strictEqual(parsed[4].opcode, S2C.CONTAINER);
    assert.strictEqual(parsed[4].seq, 14);
    assert.strictEqual(decodeContainer(parsed[4].payload).items[0].id, 'potion');

    // Verify decodeFrame returns the first frame cleanly:
    const firstOnly = decodeFrame(singleCoalesced);
    assert.strictEqual(firstOnly.opcode, S2C.MOVE);
    assert.strictEqual(firstOnly.seq, 10);
    assert.strictEqual(decodeMove(firstOnly.payload).id, 1);
}

function testKickBypassesBatching() {
    const sock = mockSocket();
    const session = new GameSession({
        socket: sock,
        ip: '127.0.0.1',
        world: null,
        settings: { limits: { outboundBatching: true } },
        limiter: new RateLimiter(),
        log: createLog({ logLevel: 'silent' })
    });

    session.batching = true;
    session.send(S2C.MOVE, encodeMove({ id: 1, x: 10, y: 10, z: 0, dir: 0 }));
    assert.strictEqual(session.outboundQueue.length, 1);

    // kick should immediately send KICK and close socket:
    session.kick(REASON.LOGOUT);
    assert.strictEqual(session.outboundQueue.length, 0, 'Queue cleared on kick');
    assert.strictEqual(sock.sent.length, 1, 'KICK frame sent immediately');
    assert.strictEqual(sock.closed, true);

    const kickFrame = decodeFrame(sock.sent[0]);
    assert.strictEqual(kickFrame.opcode, S2C.KICK);
    assert.strictEqual(decodeKick(kickFrame.payload), REASON.LOGOUT);
}

async function testRealWebSocketBatchingEndToEnd() {
    await withHttp(async ({ port, limiter, world }) => {
        // Register and get token:
        const { request } = require('./helpers');
        const reg = await request(port, {
            method: 'POST',
            path: '/v1/register',
            body: { email: 'batch_test@example.com', password: 'password123' }
        });
        assert.strictEqual(reg.status, 201);
        const cookie = `sid=${reg.sid}`;

        const ch = await request(port, {
            method: 'POST',
            path: '/v1/characters',
            cookie,
            body: { name: 'BatchHero', vocation: 'scout' }
        });
        assert.strictEqual(ch.status, 201);

        const play = await request(port, {
            method: 'POST',
            path: '/v1/play',
            cookie,
            body: { characterId: ch.json.id }
        });
        assert.strictEqual(play.status, 200);
        const token = play.json.token;

        // Connect real WebSocket:
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
        ws.binaryType = 'arraybuffer';
        const inbox = [];
        const closed = { code: null, done: false };

        ws.on('message', (data) => {
            const f = decodeFrame(Buffer.from(data));
            if (f) inbox.push(f);
        });
        ws.on('close', (code) => {
            closed.code = code;
            closed.done = true;
        });

        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });

        // Wait for HELLO:
        await waitFor(() => inbox.some((f) => f.opcode === S2C.HELLO), 1500);

        // Send ENTER:
        ws.send(encodeFrame(C2S.ENTER, 1, parseHexToken(token)));
        await waitFor(() => inbox.some((f) => f.opcode === S2C.ENTER_WORLD), 1500);

        // Clear inbox before move:
        const initialCount = inbox.length;

        // Send MOVE_STEP:
        ws.send(encodeFrame(C2S.MOVE_STEP, 2, Buffer.from([0])));
        await waitFor(() => inbox.some((f) => f.opcode === S2C.MOVE), 1000);
        await waitFor(() => inbox.some((f) => f.opcode === S2C.VIEWPORT), 1000);

        assert.ok(inbox.some((f) => f.opcode === S2C.MOVE), 'Must receive MOVE');
        assert.ok(inbox.some((f) => f.opcode === S2C.VIEWPORT), 'Must receive VIEWPORT');

        // Check limiter metrics:
        assert.ok(limiter.metrics.outboundBatchesFlushed >= 1, 'Must record batches flushed in metrics');
        assert.ok(limiter.metrics.outboundFramesFlushed >= 2, 'Must record frames flushed in metrics');

        ws.close();
        await waitFor(() => closed.done, 800);
    });
}

function testStressHighThroughputBatching() {
    const world = makeWorld();
    const NUM_PLAYERS = 200;
    const TICKS = 5;
    const sessions = [];

    for (let i = 0; i < NUM_PLAYERS; i++) {
        sessions.push(makeSession(world, 1000 + i, `Stress_${i}`));
    }

    let totalEventsPushed = 0;
    for (let t = 1; t <= TICKS; t++) {
        world._tickIndex = t;
        world._batchingOutbound = true;

        // Generate 3 micro-events per player per tick (600 events per tick):
        for (let i = 0; i < NUM_PLAYERS; i++) {
            const s = sessions[i];
            s.send(S2C.MOVE, encodeMove({ id: s.id, x: 10, y: 10, z: 0, dir: 0 }));
            s.send(S2C.STATS, encodeStats({ id: s.id, hp: 100, hpMax: 100, mp: 50, mpMax: 50 }));
            s.send(S2C.SWING, encodeSwing({ sourceId: s.id, targetId: 0, amount: 0, flags: 1 }));
            totalEventsPushed += 3;
        }

        // Before flush: outboundQueue on all sessions should have 3 items
        assert.strictEqual(sessions[0].outboundQueue.length, 3);
        assert.strictEqual(world._dirtyOutboundSessions.size, NUM_PLAYERS);

        // Flush:
        const flushed = world.flushOutbound();
        assert.strictEqual(flushed, NUM_PLAYERS * 3);
        assert.strictEqual(sessions[0].outboundQueue.length, 0);
        assert.strictEqual(world._dirtyOutboundSessions.size, 0);
        world._batchingOutbound = false;
    }

    assert.strictEqual(totalEventsPushed, NUM_PLAYERS * 3 * TICKS);
    // Each session received TICKS * 3 frames, but flushed in exactly TICKS batches:
    assert.strictEqual(sessions[0].flushedBatchesCount, TICKS);
    assert.strictEqual(sessions[0].flushedFramesCount, TICKS * 3);
    assert.strictEqual(sessions[0].socket.sent.length, TICKS * 3);
}

async function main() {
    testBatchingQueueAccumulation();
    testWorldStepOutboundBatchingLifecycle();
    testTCPWriteSyscallReductionWithCorking();
    testDirtySessionScaleInvariant();
    testCoalescePayloadsMode();
    testDecodeFramesMultiFrameParser();
    testKickBypassesBatching();
    await testRealWebSocketBatchingEndToEnd();
    testStressHighThroughputBatching();
    console.log('ok phase5_2_websocket_batching');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
