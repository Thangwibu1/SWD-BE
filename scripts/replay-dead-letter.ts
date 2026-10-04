import amqp from 'amqplib';
import { replayDeadLetters } from '../src/sut/shared/events/dead-letter.js';

const queue = process.argv[2];
const limit = Number(process.argv[3] ?? 1);
if (!queue || !process.env['RABBITMQ_URL']) throw new Error('Usage: RABBITMQ_URL=<broker> npm run events:replay-dead -- <queue> [limit]');
const connection = await amqp.connect(process.env['RABBITMQ_URL']);
try {
  console.log(JSON.stringify({ queue, replayed: await replayDeadLetters(connection, queue, limit) }));
} finally {
  await connection.close();
}
