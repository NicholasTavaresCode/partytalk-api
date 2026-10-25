import { createHmac } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { IceServer } from './entities/ice-servers.entity';

/**
 * ICE servers for one user's voice-mesh connections: the free STUN servers, plus
 * the TURN relay — for peers STUN can't connect — with a time-limited credential
 * in coturn's `use-auth-secret` scheme (the "TURN REST API"):
 *
 *   username   = "<expiry, unix seconds>:<uid>"
 *   credential = base64(HMAC-SHA1(secret, username))
 *
 * The relay checks it with the shared secret alone, so nothing is stored and a
 * leaked credential dies on its own. TURN is omitted unless both URLs and the
 * secret are configured.
 */
export function buildIceServers(
  webrtc: AppConfig['webrtc'],
  uid: string,
  nowMs: number,
): IceServer[] {
  const servers: IceServer[] = [];
  if (webrtc.stunUrls.length) {
    servers.push({ urls: webrtc.stunUrls });
  }
  if (webrtc.turnUrls.length && webrtc.turnSecret) {
    const expiry = Math.floor(nowMs / 1000) + webrtc.turnCredentialTtlSeconds;
    const username = `${expiry}:${uid}`;
    const credential = createHmac('sha1', webrtc.turnSecret)
      .update(username)
      .digest('base64');
    servers.push({ urls: webrtc.turnUrls, username, credential });
  }
  return servers;
}
