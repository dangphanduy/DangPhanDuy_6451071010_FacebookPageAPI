const { Kafka } = require('kafkajs');

const BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const TOPIC = process.env.KAFKA_TOPIC || 'raw_events';

const kafka = new Kafka({ clientId: 'test-producer', brokers: [BROKER] });
const producer = kafka.producer();

async function sendTestComment() {
  await producer.connect();
  const payload = {
    entry: [
      {
        changes: [
          {
            field: 'feed',
            value: {
              comment_id: `test_${Date.now()}`,
              post_id: 'post_test_1',
              from: { id: 'spammer1', name: 'Spammer' },
              message: 'Amazing deal! Click http://spam.example.com now',
            },
          },
        ],
      },
    ],
    receivedAt: new Date().toISOString(),
  };

  await producer.send({
    topic: TOPIC,
    messages: [{ value: JSON.stringify(payload) }],
  });

  console.log(`[TestProducer] Sent test comment to ${TOPIC}`);
  await producer.disconnect();
}

sendTestComment().catch((err) => {
  console.error('[TestProducer] Error:', err.message);
  process.exit(1);
});
