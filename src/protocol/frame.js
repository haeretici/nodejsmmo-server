'use strict';

const { HEADER_SIZE } = require('./opcodes');

class Writer {
    constructor() {
        this.chunks = [];
    }

    u8(v) {
        this.chunks.push(Buffer.from([v & 0xff]));
        return this;
    }

    i8(v) {
        const b = Buffer.alloc(1);
        b.writeInt8(v);
        this.chunks.push(b);
        return this;
    }

    u16(v) {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(v);
        this.chunks.push(b);
        return this;
    }

    i16(v) {
        const b = Buffer.alloc(2);
        b.writeInt16LE(v);
        this.chunks.push(b);
        return this;
    }

    u32(v) {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(v >>> 0);
        this.chunks.push(b);
        return this;
    }

    str(s) {
        const b = Buffer.from(String(s), 'utf8');
        if (b.length > 255) {
            throw new Error('string too long');
        }
        this.u8(b.length);
        this.chunks.push(b);
        return this;
    }

    u16array(arr) {
        const n = arr.length;
        const b = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) {
            b.writeUInt16LE(arr[i], i * 2);
        }
        this.chunks.push(b);
        return this;
    }

    raw(buf) {
        this.chunks.push(Buffer.from(buf));
        return this;
    }

    toBuffer() {
        return Buffer.concat(this.chunks);
    }
}

class Reader {
    constructor(buf) {
        this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        this.o = 0;
    }

    need(n) {
        if (this.o + n > this.buf.length) {
            const err = new Error('truncated');
            err.code = 'TRUNCATED';
            throw err;
        }
    }

    u8() {
        this.need(1);
        const v = this.buf[this.o];
        this.o += 1;
        return v;
    }

    i8() {
        this.need(1);
        const v = this.buf.readInt8(this.o);
        this.o += 1;
        return v;
    }

    u16() {
        this.need(2);
        const v = this.buf.readUInt16LE(this.o);
        this.o += 2;
        return v;
    }

    i16() {
        this.need(2);
        const v = this.buf.readInt16LE(this.o);
        this.o += 2;
        return v;
    }

    u32() {
        this.need(4);
        const v = this.buf.readUInt32LE(this.o);
        this.o += 4;
        return v;
    }

    str() {
        const n = this.u8();
        this.need(n);
        const s = this.buf.toString('utf8', this.o, this.o + n);
        this.o += n;
        return s;
    }

    u16array(n) {
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
            out[i] = this.u16();
        }
        return out;
    }

    rest() {
        return this.buf.subarray(this.o);
    }
}

function encodeFrame(opcode, seq, payload) {
    const p = payload && payload.length ? Buffer.from(payload) : Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(HEADER_SIZE + p.length);
    buf.writeUInt16LE(opcode & 0xffff, 0);
    buf.writeUInt32LE(seq >>> 0, 2);
    p.copy(buf, HEADER_SIZE);
    return buf;
}

function decodeFrame(buf) {
    if (!buf || buf.length < HEADER_SIZE) return null;
    const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    return {
        opcode: raw.readUInt16LE(0),
        seq: raw.readUInt32LE(2),
        payload: Buffer.from(raw.subarray(HEADER_SIZE))
    };
}

function clampU16(v) {
    const n = Number(v) || 0;
    if (n < 0) return 0;
    if (n > 0xffff) return 0xffff;
    return n;
}

module.exports = {
    Writer,
    Reader,
    encodeFrame,
    decodeFrame,
    clampU16
};
