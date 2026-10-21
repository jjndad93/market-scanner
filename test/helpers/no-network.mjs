// Test helper, loaded into spawned CLI processes with `node --import`: any attempt to use the
// network throws, so a test fails loudly if a command that should be offline makes a request.
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

const deny = (what) => () => {
  throw new Error(`NETWORK BLOCKED IN TEST: ${what}`);
};
net.Socket.prototype.connect = deny('socket connect');
net.connect = net.createConnection = deny('net.connect');
tls.connect = deny('tls.connect');
dns.lookup = deny('dns.lookup');
dns.promises.lookup = deny('dns.promises.lookup');
globalThis.fetch = deny('fetch');
