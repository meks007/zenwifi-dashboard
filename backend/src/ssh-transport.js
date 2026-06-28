'use strict';

const { Client } = require('ssh2');
const logger     = require('./logger');

/**
 * Run a single command on an AP over SSH.
 * Resolves with the full stdout string.
 * Rejects on connection error or exec error.
 */
function runSSH(ap, command) {
  return new Promise(function(resolve, reject) {
    var conn      = new Client();
    var output    = '';
    var stderrOut = '';

    logger.debug('[SSH] ' + ap.name + ' CMD: ' + command);

    conn.on('ready', function() {
      logger.debug('[SSH] ' + ap.name + ' connection ready');
      conn.exec(command, function(err, stream) {
        if (err) { conn.end(); return reject(err); }
        stream.on('data',        function(data) { output    += data.toString(); });
        stream.stderr.on('data', function(data) { stderrOut += data.toString(); });
        stream.on('close', function() {
          if (stderrOut.trim()) logger.debug('[SSH] ' + ap.name + ' stderr: ' + stderrOut.trim());
          conn.end();
          resolve(output);
        });
      });
    });

    conn.on('error', function(err) {
      logger.error('[SSH] ' + ap.name + ' (' + ap.host + ') connection error: ' + err.message);
      reject(err);
    });

    conn.connect({
      host:         ap.host,
      port:         ap.ssh_port || 22,
      username:     ap.username,
      password:     ap.password,
      readyTimeout: 10000,
      hostVerifier: function() { return true; },
    });
  });
}

module.exports = { runSSH };
