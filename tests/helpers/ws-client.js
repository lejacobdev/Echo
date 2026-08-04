// Minimal WebSocket *client* for tests (client frames must be masked).
import net from 'node:net';
import crypto from 'node:crypto';

export function wsConnect(port, path, cookie = null) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const messages = [];
    const waiters = [];

    function deliver(msg) {
      const w = waiters.shift();
      if (w) w(msg);
      else messages.push(msg);
    }

    function parseFrames() {
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + len) return;
        const payload = buffer.subarray(offset, offset + len);
        buffer = buffer.subarray(offset + len);
        if (opcode === 0x1) {
          try { deliver(JSON.parse(payload.toString('utf8'))); } catch { /* ignore */ }
        } else if (opcode === 0x8) {
          socket.end();
        }
      }
    }

    const client = {
      send(obj) {
        const payload = Buffer.from(JSON.stringify(obj));
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        let header;
        if (payload.length < 126) {
          header = Buffer.from([0x81, 0x80 | payload.length]);
        } else {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        }
        socket.write(Buffer.concat([header, mask, masked]));
      },
      next(timeoutMs = 3000) {
        if (messages.length) return Promise.resolve(messages.shift());
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('ws message timeout')), timeoutMs);
          waiters.push((msg) => { clearTimeout(timer); res(msg); });
        });
      },
      close() { socket.destroy(); },
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buffer.subarray(0, idx).toString();
        buffer = buffer.subarray(idx + 4);
        if (!head.split('\r\n')[0].includes('101')) {
          reject(new Error(`handshake failed: ${head.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        handshaken = true;
        resolve(client);
      }
      if (handshaken) parseFrames();
    });
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        (cookie ? `Cookie: ${cookie}\r\n` : '') +
        '\r\n'
      );
    });
  });
}
