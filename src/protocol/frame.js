'use strict';

const { HEADER_SIZE } = require('./opcodes');

const DEFAULT_SLAB_SIZE = 8192; // 8 KB reusable scratch buffer slab

let currentSlab = null;
let slabOffset = 0;
let currentWriter = null;
let totalSlabsAllocated = 0;
let totalBytesWritten = 0;

class FastWriter {
    constructor(opts) {
        this.parent = currentWriter;
        currentWriter = this;
        this.offset = 0;

        if (typeof opts === 'number') {
            const cap = Math.max(opts, 64);
            this.buf = Buffer.allocUnsafe(cap);
            this.start = 0;
            this.isSlab = false;
        } else if (opts && opts.standalone) {
            const cap = Math.max(Number(opts.capacity) || DEFAULT_SLAB_SIZE, 64);
            this.buf = Buffer.allocUnsafe(cap);
            this.start = 0;
            this.isSlab = false;
        } else if (this.parent === null) {
            if (!currentSlab || slabOffset + 512 > currentSlab.length) {
                currentSlab = Buffer.allocUnsafe(DEFAULT_SLAB_SIZE);
                slabOffset = 0;
                totalSlabsAllocated += 1;
            }
            this.buf = currentSlab;
            this.start = slabOffset;
            this.isSlab = true;
        } else {
            // Nested writer fallback to prevent slab offset interleaving
            this.buf = Buffer.allocUnsafe(DEFAULT_SLAB_SIZE);
            this.start = 0;
            this.isSlab = false;
        }
    }

    ensure(needed) {
        const required = this.start + this.offset + needed;
        if (required <= this.buf.length) return;
        const newCap = Math.max(DEFAULT_SLAB_SIZE, (this.offset + needed) * 2);
        const newBuf = Buffer.allocUnsafe(newCap);
        if (this.offset > 0) {
            this.buf.copy(newBuf, 0, this.start, this.start + this.offset);
        }
        this.buf = newBuf;
        this.start = 0;
        this.isSlab = false;
    }

    u8(v) {
        this.ensure(1);
        this.buf[this.start + this.offset] = v & 0xff;
        this.offset += 1;
        return this;
    }

    i8(v) {
        this.ensure(1);
        this.buf.writeInt8(Number(v) || 0, this.start + this.offset);
        this.offset += 1;
        return this;
    }

    u16(v) {
        this.ensure(2);
        this.buf.writeUInt16LE((v & 0xffff) >>> 0, this.start + this.offset);
        this.offset += 2;
        return this;
    }

    i16(v) {
        this.ensure(2);
        this.buf.writeInt16LE(Number(v) || 0, this.start + this.offset);
        this.offset += 2;
        return this;
    }

    u32(v) {
        this.ensure(4);
        this.buf.writeUInt32LE((v >>> 0), this.start + this.offset);
        this.offset += 4;
        return this;
    }

    str(s) {
        const strVal = String(s == null ? '' : s);
        const byteLen = Buffer.byteLength(strVal, 'utf8');
        if (byteLen > 255) {
            if (currentWriter === this) currentWriter = this.parent;
            throw new Error('string too long');
        }
        this.ensure(1 + byteLen);
        const off = this.start + this.offset;
        this.buf[off] = byteLen;
        if (byteLen > 0) {
            this.buf.write(strVal, off + 1, byteLen, 'utf8');
        }
        this.offset += 1 + byteLen;
        return this;
    }

    u16array(arr) {
        if (!arr) return this;
        const n = arr.length | 0;
        if (n === 0) return this;
        this.ensure(n * 2);
        let off = this.start + this.offset;
        for (let i = 0; i < n; i++) {
            this.buf.writeUInt16LE((arr[i] & 0xffff) >>> 0, off);
            off += 2;
        }
        this.offset += n * 2;
        return this;
    }

    raw(buf) {
        if (!buf) return this;
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        const n = b.length;
        if (n === 0) return this;
        this.ensure(n);
        b.copy(this.buf, this.start + this.offset);
        this.offset += n;
        return this;
    }

    toBuffer(copy = false) {
        const slice = this.buf.subarray(this.start, this.start + this.offset);
        totalBytesWritten += this.offset;
        if (this.isSlab) {
            slabOffset = (this.start + this.offset + 7) & ~7;
            this.isSlab = false;
        }
        if (currentWriter === this) {
            currentWriter = this.parent;
        }
        return copy ? Buffer.from(slice) : slice;
    }

    reset() {
        this.offset = 0;
        return this;
    }

    get length() {
        return this.offset;
    }

    get size() {
        return this.offset;
    }

    get capacity() {
        return this.buf.length - this.start;
    }

    static resetSlab() {
        currentSlab = null;
        slabOffset = 0;
        currentWriter = null;
        totalSlabsAllocated = 0;
        totalBytesWritten = 0;
    }

    static getSlabStats() {
        return {
            slabSize: DEFAULT_SLAB_SIZE,
            slabsAllocated: totalSlabsAllocated,
            bytesWritten: totalBytesWritten,
            currentOffset: slabOffset,
            hasActiveWriter: currentWriter !== null
        };
    }
}

const Writer = FastWriter;

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
    const p = Buffer.isBuffer(payload)
        ? payload
        : (payload && payload.length ? Buffer.from(payload) : null);
    const pLen = p ? p.length : 0;
    const buf = Buffer.allocUnsafe(HEADER_SIZE + pLen);
    buf.writeUInt16LE(opcode & 0xffff, 0);
    buf.writeUInt32LE(seq >>> 0, 2);
    if (pLen > 0) {
        p.copy(buf, HEADER_SIZE);
    }
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
    FastWriter,
    Writer,
    Reader,
    encodeFrame,
    decodeFrame,
    clampU16
};
