// Preloaded (node --require) by the privacy test: every way Node can reach the network is blocked, and each attempt
// is written to NETWORK_LOG, so the test can prove that none was made. Applies to the process it is loaded in, to its
// worker threads (they inherit --require) and to child processes started with NODE_OPTIONS.
const fs = require('fs');
const log = (what) => {
  try {
    fs.appendFileSync(process.env.NETWORK_LOG, `${process.pid} ${what}\n`);
  } catch {
    // No log: still blocked.
  }
};
const refuse = (what) => {
  log(what);
  throw new Error(`network blocked: ${what}`);
};
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
// Child processes' stdin and stdout are pipes set up without connect(): every connect() is a connection out.
net.Socket.prototype.connect = function (...args) {
  return refuse(`socket.connect ${JSON.stringify(args[0])}`);
};
net.connect = net.createConnection = (...args) => refuse(`net.connect ${JSON.stringify(args[0])}`);
tls.connect = (...args) => refuse(`tls.connect ${JSON.stringify(args[0])}`);
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) dns[name] = (host) => refuse(`dns.${name} ${host}`);
if (dns.promises) for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns.promises[name] = async (host) => refuse(`dns.promises.${name} ${host}`);
for (const mod of [http, https]) {
  mod.request = (url) => refuse(`${mod === http ? 'http' : 'https'}.request ${typeof url === 'string' ? url : url && url.hostname}`);
  mod.get = mod.request;
}
dgram.createSocket = () => refuse('dgram.createSocket');
globalThis.fetch = async (input) => refuse(`fetch ${typeof input === 'string' ? input : input && (input.url || input.href)}`);
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = function () { refuse('WebSocket'); };
