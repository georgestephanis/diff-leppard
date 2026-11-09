"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nullLogger = exports.SEVERITIES = void 0;
exports.severityRank = severityRank;
/** Ordered most to least severe. */
exports.SEVERITIES = ['critical', 'major', 'minor', 'nit'];
function severityRank(s) {
    return exports.SEVERITIES.indexOf(s);
}
exports.nullLogger = {
    info() { },
    warn() { },
    error() { },
    debug() { },
};
