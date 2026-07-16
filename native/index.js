'use strict';

try {
    module.exports = require('./build/Release/ply_reader.node');
} catch (e) {
    module.exports = null;
}
