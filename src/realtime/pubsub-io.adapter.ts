import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { PubSub } from '@google-cloud/pubsub';
import { createAdapter } from '@socket.io/gcp-pubsub-adapter';
import { Namespace, Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO server factory that shares rooms and broadcasts across every API
 * instance through a Google Cloud Pub/Sub topic.
 *
 * Why: Cloud Run does not guarantee one instance, even at max-instances 1 — it
 * starts a replacement while the old one still holds open WebSockets. With the
 * default in-memory adapter, a socket on one instance never hears an event
 * emitted on another (a host saw nobody join; voice offers went nowhere).
 *
 * Each instance gets its own subscription on the topic. A clean shutdown
 * deletes it; one killed abruptly expires after a day idle. Without a topic
 * (local dev, tests) Socket.IO keeps its in-memory adapter.
 */
export class PubSubIoAdapter extends IoAdapter {
  private readonly logger = new Logger(PubSubIoAdapter.name);

  constructor(
    app: INestApplicationContext,
    private readonly topicName: string | undefined,
    private readonly projectId: string,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (!this.topicName) {
      return server;
    }

    const topicName = this.topicName;
    const createPubSubAdapter = createAdapter(
      new PubSub({ projectId: this.projectId }).topic(topicName),
      {
        subscriptionPrefix: 'partytalk-api',
        subscriptionOptions: {
          expirationPolicy: { ttl: { seconds: 24 * 60 * 60 } },
          // Only live events matter; nothing needs replaying after 10 minutes.
          messageRetentionDuration: { seconds: 10 * 60 },
        },
      },
    );

    // The adapter only logs at debug level if its subscription can't be made
    // (missing topic or IAM), and its init would reject unhandled. Say so loudly.
    // A plain `function`, not an arrow: Socket.IO instantiates it with `new`.
    const logger = this.logger;
    server.adapter(function (nsp: Namespace) {
      const adapter = createPubSubAdapter(nsp);
      const init = adapter.init.bind(adapter);
      adapter.init = () =>
        Promise.resolve(init())
          .then(() =>
            logger.log(
              `Socket.IO namespace ${nsp.name} shared across instances via Pub/Sub topic "${topicName}"`,
            ),
          )
          .catch((error: Error) =>
            logger.error(
              `Pub/Sub adapter failed for namespace ${nsp.name}: ${error.message}. Realtime events will NOT reach sockets on other instances — check that topic "${topicName}" exists and the service account has roles/pubsub.editor.`,
            ),
          );
      return adapter;
    } as never);
    return server;
  }
}
