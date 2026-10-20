import { Kafka, logLevel } from 'kafkajs';
import { config } from './config.js';

export function createKafka(clientId: string) {
  return new Kafka({ clientId, brokers: config.kafkaBrokers, logLevel: logLevel.WARN });
}

export async function ensureTopic(kafka: Kafka, topic = config.receiptTopic) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics: [{ topic, numPartitions: 3, replicationFactor: 1 }], waitForLeaders: true });
  } finally {
    await admin.disconnect();
  }
}
