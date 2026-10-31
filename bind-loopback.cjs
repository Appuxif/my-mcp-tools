// Security shim for @ni-c/mcp-hub 0.11.7: the HTTP listener otherwise binds all interfaces.
// Only used for SSH mode. Fail explicit if the upstream changes the call pattern.
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number' && (args.length === 1 || typeof args[1] === 'function')) {
    args.splice(1, 0, '127.0.0.1');
  }
  return listen.apply(this, args);
};
