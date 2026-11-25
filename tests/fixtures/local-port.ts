import net from 'node:net';

/** Lets parallel browser fixtures choose independent loopback ports. */
export async function localPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('A test listener did not receive a port.');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
