import { Server } from 'http';
import { createApp } from '../src/app';
import { queryClient } from '../src/db';

export interface TestContext {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestContext> {
  const app = createApp();
  return new Promise((resolve, reject) => {
    // Port 0 binds to any available ephemeral port
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to determine test server address'));
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        baseUrl,
        close: async () => {
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
    server.on('error', reject);
  });
}

export async function closeDb() {
  await queryClient.end();
}
