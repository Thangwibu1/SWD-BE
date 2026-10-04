import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { execa } from 'execa';

export interface TestRabbitMQ {
  container: string;
  url: string;
  stop: () => Promise<void>;
}

export async function startTestRabbitMQ(name: string): Promise<TestRabbitMQ> {
  if (!/^[a-z0-9-]{3,40}$/.test(name)) throw new Error(`Invalid test container name ${name}`);
  const versions = Object.fromEntries(readFileSync(path.resolve('versions.env'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.split('=', 2)));
  const container = `arch-eval-test-${name}-${process.pid}-${Date.now()}`;
  await execa('docker', [
    'run', '-d', '--name', container, '--hostname', container, '--user', '100:101',
    '--tmpfs', '/var/lib/rabbitmq:uid=100,gid=101,mode=0770',
    '-p', '127.0.0.1::5672', `rabbitmq:${versions['RABBITMQ_VERSION']}`,
  ]);
  const portOutput = await execa('docker', ['port', container, '5672/tcp']);
  const port = portOutput.stdout.split(/\r?\n/)[0]?.split(':').pop();
  if (!port) throw new Error('Could not resolve RabbitMQ test port');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
      const finish = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
    const brokerReady = ready
      ? await execa('docker', ['exec', container, 'rabbitmq-diagnostics', '-q', 'check_running'], { reject: false })
      : undefined;
    if (brokerReady?.exitCode === 0) {
      return {
        container,
        url: `amqp://127.0.0.1:${port}`,
        stop: async () => {
          await execa('docker', ['rm', '-f', '-v', container], { reject: false });
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = await execa('docker', ['logs', '--tail', '80', container], { reject: false });
  await execa('docker', ['rm', '-f', '-v', container], { reject: false });
  throw new Error(`RabbitMQ test container did not become ready:\n${logs.all ?? logs.stdout ?? logs.stderr}`);
}
