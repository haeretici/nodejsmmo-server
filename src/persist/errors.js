'use strict';

class DuplicateError extends Error {
    constructor(message) {
        super(message || 'duplicate');
        this.name = 'DuplicateError';
        this.code = 'DUPLICATE';
    }
}

module.exports = { DuplicateError };
