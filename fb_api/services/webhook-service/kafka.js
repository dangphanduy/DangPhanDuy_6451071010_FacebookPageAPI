const { Kafka } = require("kafkajs");

const kafka = new Kafka({
  clientId: "webhook-service",
  brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
});

const producer = kafka.producer();

async function connectProducer() {
  await producer.connect();
  console.log("Kafka producer connected");
}

async function sendToKafka(topic, message) {
  await producer.send({
    topic,
    messages: [
      {
        value: JSON.stringify(message),
      },
    ],
  });
}

module.exports = {
  connectProducer,
  sendToKafka,
};