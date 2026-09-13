'use strict';

const assert = require('assert');
const {
    FastWriter,
    Writer,
    Reader,
    encodeFrame,
    decodeFrame
} = require('../src/protocol/frame');
const {
    encodeMove,
    decodeMove,
    encodeAppear,
    decodeAppear,
    encodeStats,
    decodeStats,
    encodeSwing,
    decodeSwing,
    encodeEnterWorld,
    decodeEnterWorld,
    encodeViewport,
    decodeViewport
} = require('../src/protocol/messages');
const { C2S, S2C, PROTOCOL_VERSION } = require('../src/protocol/opcodes');

function testBasicPrimitiveEncoding() {
    FastWriter.resetSlab();
    const w = new FastWriter();
    w.u8(255)
        .u8(0)
        .i8(-120)
        .i8(120)
        .u16(65530)
        .i16(-32000)
        .i16(32000)
        .u32(3000000000)
        .str('FastWriter Test')
        .u16array([10, 20, 30])
        .raw(Buffer.from([1, 2, 3, 4]));

    assert.strictEqual(w.length, 1 + 1 + 1 + 1 + 2 + 2 + 2 + 4 + (1 + 15) + (3 * 2) + 4);
    assert.strictEqual(w.size, w.length);

    const buf = w.toBuffer();
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.length, w.length);

    const r = new Reader(buf);
    assert.strictEqual(r.u8(), 255);
    assert.strictEqual(r.u8(), 0);
    assert.strictEqual(r.i8(), -120);
    assert.strictEqual(r.i8(), 120);
    assert.strictEqual(r.u16(), 65530);
    assert.strictEqual(r.i16(), -32000);
    assert.strictEqual(r.i16(), 32000);
    assert.strictEqual(r.u32(), 3000000000);
    assert.strictEqual(r.str(), 'FastWriter Test');
    assert.deepStrictEqual(r.u16array(3), [10, 20, 30]);
    assert.deepStrictEqual(Buffer.from(r.rest()), Buffer.from([1, 2, 3, 4]));
}

function testStringEncodingEdgeCases() {
    FastWriter.resetSlab();

    // Empty string
    const bEmpty = new FastWriter().str('').toBuffer();
    assert.strictEqual(bEmpty.length, 1);
    assert.strictEqual(new Reader(bEmpty).str(), '');

    // Null/undefined handled gracefully as empty string
    const bNull = new FastWriter().str(null).toBuffer();
    assert.strictEqual(new Reader(bNull).str(), '');

    // UTF-8 multibyte characters (accents, emojis)
    const unicodeStr = 'Dungeon Engine ⚔️ 火焰';
    const bUnicode = new FastWriter().str(unicodeStr).toBuffer();
    assert.strictEqual(new Reader(bUnicode).str(), unicodeStr);

    // Max 255 bytes string
    const maxStr = 'A'.repeat(255);
    const bMax = new FastWriter().str(maxStr).toBuffer();
    assert.strictEqual(new Reader(bMax).str(), maxStr);

    // Exceeding 255 bytes must throw
    const overStr = 'B'.repeat(256);
    assert.throws(() => {
        new FastWriter().str(overStr);
    }, /string too long/);

    // After exception, the next writer must function normally without being poisoned
    const nextWriter = new FastWriter();
    nextWriter.str('Clean recovery');
    assert.strictEqual(new Reader(nextWriter.toBuffer()).str(), 'Clean recovery');
}

function testSlabAllocatorContiguousAndAlignment() {
    FastWriter.resetSlab();
    const stats0 = FastWriter.getSlabStats();
    assert.strictEqual(stats0.slabsAllocated, 0);

    // Message 1: 10 bytes (u32, i16, i16, i8, u8)
    const m1 = new FastWriter().u32(1001).i16(10).i16(20).i8(0).u8(1).toBuffer();
    assert.strictEqual(m1.length, 10);

    const stats1 = FastWriter.getSlabStats();
    assert.strictEqual(stats1.slabsAllocated, 1);
    // (10 bytes written + 7) & ~7 = 16 (8-byte alignment)
    assert.strictEqual(stats1.currentOffset, 16);

    // Message 2: 12 bytes (u32, u16, u16, u16, u16)
    const m2 = new FastWriter().u32(1002).u16(100).u16(200).u16(50).u16(100).toBuffer();
    assert.strictEqual(m2.length, 12);

    const stats2 = FastWriter.getSlabStats();
    assert.strictEqual(stats2.slabsAllocated, 1, 'Still on same 8KB slab');
    // 16 + 12 = 28; aligned to 32
    assert.strictEqual(stats2.currentOffset, 32);

    // Verify m1 and m2 share the same underlying ArrayBuffer (zero-copy slices from the same slab)
    assert.strictEqual(m1.buffer, m2.buffer, 'Both messages allocated from the exact same slab buffer');
    assert.strictEqual(m2.byteOffset - m1.byteOffset, 16);

    // Verify contents did not overwrite each other
    assert.strictEqual(m1.readUInt32LE(0), 1001);
    assert.strictEqual(m2.readUInt32LE(0), 1002);
}

function testSlabAutoRotationOnExhaustion() {
    FastWriter.resetSlab();

    // Fill up the first slab close to 8KB
    // 38 blocks * 200 bytes = 7600 bytes
    for (let i = 0; i < 38; i++) {
        const dummy = new Uint8Array(199);
        new FastWriter().u8(i).raw(dummy).toBuffer();
    }

    // Write a 100-byte block so slabOffset exceeds 7680 (8192 - 512 headroom)
    new FastWriter().raw(new Uint8Array(100)).toBuffer();

    const statsBefore = FastWriter.getSlabStats();
    assert.strictEqual(statsBefore.slabsAllocated, 1);
    assert.strictEqual(statsBefore.currentOffset, 7704);

    // Next allocation exceeds remaining slab capacity (> 8192 - 7704 = 488 < 512)
    // Slab allocator must automatically rotate to a fresh 8KB slab
    const nextMsg = new FastWriter().u32(9999).toBuffer();
    const statsAfter = FastWriter.getSlabStats();
    assert.strictEqual(statsAfter.slabsAllocated, 2, 'Rotated to fresh 8KB slab on exhaustion');
    assert.strictEqual(statsAfter.currentOffset, 8);
    assert.strictEqual(nextMsg.readUInt32LE(0), 9999);
}

function testReentrancyAndNestedWriters() {
    FastWriter.resetSlab();

    // Outer writer starts writing
    const outer = new FastWriter();
    outer.u32(1111);

    // Inside outer execution, a nested writer is instantiated before outer.toBuffer()
    const inner = new FastWriter();
    inner.u32(2222);
    const innerBuf = inner.toBuffer();

    // Outer resumes writing and finishes
    outer.u32(3333);
    const outerBuf = outer.toBuffer();

    // Verify inner wrote correctly
    assert.strictEqual(innerBuf.length, 4);
    assert.strictEqual(innerBuf.readUInt32LE(0), 2222);

    // Verify outer wrote both values correctly without interleaving
    assert.strictEqual(outerBuf.length, 8);
    const r = new Reader(outerBuf);
    assert.strictEqual(r.u32(), 1111);
    assert.strictEqual(r.u32(), 3333);

    // Verify next top-level writer reclaims the shared slab
    const after = new FastWriter();
    after.u32(4444);
    const afterBuf = after.toBuffer();
    assert.strictEqual(afterBuf.readUInt32LE(0), 4444);
}

function testLargePayloadDynamicExpansion() {
    FastWriter.resetSlab();

    // Create a 16KB payload (exceeds default 8KB slab)
    const largeCount = 8000;
    const tiles = new Array(largeCount);
    for (let i = 0; i < largeCount; i++) tiles[i] = (i % 10) + 1;

    const w = new FastWriter();
    w.u32(777).u16array(tiles);

    assert.strictEqual(w.length, 4 + largeCount * 2);
    const buf = w.toBuffer();
    assert.strictEqual(buf.length, 4 + largeCount * 2);

    const r = new Reader(buf);
    assert.strictEqual(r.u32(), 777);
    const gotTiles = r.u16array(largeCount);
    assert.strictEqual(gotTiles.length, largeCount);
    assert.strictEqual(gotTiles[0], 1);
    assert.strictEqual(gotTiles[7999], (7999 % 10) + 1);
}

function testStandaloneMode() {
    // Explicit capacity constructor
    const w1 = new FastWriter(256);
    assert.ok(w1.capacity >= 256);
    w1.u32(123456);
    const b1 = w1.toBuffer();
    assert.strictEqual(b1.readUInt32LE(0), 123456);

    // Explicit standalone options object
    const w2 = new FastWriter({ standalone: true, capacity: 512 });
    assert.ok(w2.capacity >= 512);
    w2.str('standalone mode');
    const b2 = w2.toBuffer();
    assert.strictEqual(new Reader(b2).str(), 'standalone mode');
}

function testToBufferCopyOption() {
    FastWriter.resetSlab();
    const w = new FastWriter().u32(42);

    // Default: zero-copy slice (shares buffer with slab)
    const slice = w.toBuffer(false);
    assert.strictEqual(slice.readUInt32LE(0), 42);

    const w2 = new FastWriter().u32(99);
    // Copy: independent standalone buffer
    const copy = w2.toBuffer(true);
    assert.strictEqual(copy.readUInt32LE(0), 99);
}

function testWriterAliasBackwardCompatibility() {
    // Writer must be an exact alias of FastWriter
    assert.strictEqual(Writer, FastWriter);

    const w = new Writer().u8(1).u16(512).i16(-3).str('Ash').toBuffer();
    const r = new Reader(w);
    assert.strictEqual(r.u8(), 1);
    assert.strictEqual(r.u16(), 512);
    assert.strictEqual(r.i16(), -3);
    assert.strictEqual(r.str(), 'Ash');
}

function testEncodeFrameBufferZeroCopy() {
    const payload = new FastWriter().u32(888).toBuffer();
    const frame = encodeFrame(C2S.PING, 1, payload);
    const decoded = decodeFrame(frame);

    assert.strictEqual(decoded.opcode, C2S.PING);
    assert.strictEqual(decoded.seq, 1);
    assert.deepStrictEqual(decoded.payload, payload);

    // Empty payload frame
    const emptyFrame = encodeFrame(S2C.KICK, 2, null);
    const emptyDecoded = decodeFrame(emptyFrame);
    assert.strictEqual(emptyDecoded.opcode, S2C.KICK);
    assert.strictEqual(emptyDecoded.seq, 2);
    assert.strictEqual(emptyDecoded.payload.length, 0);
}

function testScaleZeroAllocationStress() {
    FastWriter.resetSlab();

    const COUNT = 10000;
    const statsBefore = FastWriter.getSlabStats();

    for (let i = 0; i < COUNT; i++) {
        // Encode a variety of realistic gameplay messages
        const moveBuf = encodeMove({ id: i, x: 10, y: 20, z: 0, dir: i % 4 });
        const mv = decodeMove(moveBuf);
        assert.strictEqual(mv.id, i);

        const statsBuf = encodeStats({
            id: i,
            hp: 100,
            hpMax: 185,
            mp: 50,
            mpMax: 90
        });
        const st = decodeStats(statsBuf);
        assert.strictEqual(st.id, i);
        assert.strictEqual(st.hp, 100);

        const swingBuf = encodeSwing({
            sourceId: i,
            targetId: i + 1,
            amount: 15,
            flags: 4
        });
        const sw = decodeSwing(swingBuf);
        assert.strictEqual(sw.sourceId, i);
        assert.strictEqual(sw.amount, 15);
    }

    const statsAfter = FastWriter.getSlabStats();
    // 30,000 messages encoded!
    // Old implementation would have allocated 30,000 * 6 = 180,000 small Buffer objects!
    // With FastWriter 8KB slab allocator, it requires only a few dozen slabs total:
    assert.ok(
        statsAfter.slabsAllocated < 150,
        `Expected < 150 slab allocations for 30,000 messages, got: ${statsAfter.slabsAllocated}`
    );
    assert.ok(statsAfter.bytesWritten >= 330000, 'Bytes written tracked accurately');
}

function main() {
    testBasicPrimitiveEncoding();
    testStringEncodingEdgeCases();
    testSlabAllocatorContiguousAndAlignment();
    testSlabAutoRotationOnExhaustion();
    testReentrancyAndNestedWriters();
    testLargePayloadDynamicExpansion();
    testStandaloneMode();
    testToBufferCopyOption();
    testWriterAliasBackwardCompatibility();
    testEncodeFrameBufferZeroCopy();
    testScaleZeroAllocationStress();
    console.log('ok phase5_1_fast_writer');
}

main();
