/**
 * Live traffic stream client (`GET /events`, Server-Sent Events).
 *
 * The facilitator emits one event per operation it handles, so you can render or
 * react to live traffic without polling and without scraping logs.
 *
 * @example
 * ```ts
 * import { streamTrafficEvents } from '@ultravioletadao/x402-sdk';
 *
 * for await (const event of streamTrafficEvents()) {
 *   console.log(event.kind, event.network, event.ok, event.tx);
 * }
 * ```
 *
 * @example Only settlements on the chains you care about. The facilitator has NO
 * server-side filter by network, so this is applied client-side.
 * ```ts
 * const stream = streamTrafficEvents({
 *   networks: ['base', 'polygon'],
 *   kinds: ['settle'],
 * });
 * for await (const event of stream) console.log(event.tx);
 * ```
 *
 * Three properties of this stream decide how you should use it:
 *
 * **It is lossy by design.** The facilitator will never slow down or fail a
 * payment to keep an observer in sync, so an event you were not connected for is
 * simply gone. Treat it as a live hint and use the chain as the source of truth.
 * Absence of events is NOT evidence that nothing happened.
 *
 * **Failed operations are not published.** Only operations that resolved emit an
 * event, so `ok: false` means "resolved and came back negative", never "blew up".
 * A stream that looks healthy is not proof that the rail is.
 *
 * **Admission is bounded.** The endpoint is public and unauthenticated, so it
 * sheds with HTTP 503 + `Retry-After` once too many subscribers are connected,
 * and returns 404 when the operator disabled it.
 */

import { DEFAULT_FACILITATOR_URL } from './facilitator';

/** Operations the facilitator publishes. */
export type TrafficEventKind = 'verify' | 'settle';

/** Operations the facilitator publishes, as a value. */
export const EVENT_KINDS: readonly TrafficEventKind[] = ['verify', 'settle'] as const;

/**
 * The stream sends a `:keepalive` comment on this cadence, so any read timeout
 * you add must comfortably exceed it or you will kill healthy connections on an
 * idle rail.
 */
export const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * One facilitator operation, as seen by an observer.
 *
 * Optional fields are *omitted* by the facilitator rather than sent as null, and
 * they are all absent when the operator runs the stream in `minimal` detail
 * mode. Never assume `payer` or `amount` is present.
 */
export interface TrafficEvent {
  /** Unix epoch **milliseconds**, UTC. Note: milliseconds, not seconds. */
  ts: number;
  kind: TrafficEventKind | string;
  /**
   * The facilitator's canonical network slug, the same one `/supported` uses.
   *
   * Beware: this is the *canonical* name, which is not always the alias you are
   * allowed to send. `skale` is accepted on the way in, but this field always
   * says `skale-base`. Match on the canonical form or you will silently drop
   * every event for that chain.
   */
  network: string;
  /** Resolved successfully? False means resolved-negative, not errored. */
  ok: boolean;
  payer?: string;
  /** Present on `settle`, absent on `verify` — nothing settled yet. */
  tx?: string;
  amount?: string;
  asset?: string;
  /**
   * The protected endpoint being bought.
   *
   * Answers "what was paid for", which the amount alone never does — two
   * 1-USDC settles are indistinguishable without it.
   */
  resource?: string;
  /** The seller receiving the payment. */
  payTo?: string;
  /** Human-readable description the seller advertised. */
  description?: string;
  /** Payment scheme: `exact`, `escrow`, `commerce`, `upto`. */
  scheme?: string;
  /**
   * Why the operation failed, as a BOUNDED CATEGORY — never the error text.
   *
   * Present only on operations that errored, and only where the operator set
   * `X402_EVENTS_PUBLISH_FAILURES=true`. A closed set (`contract_revert`,
   * `invalid_signature`, `insufficient_funds`, `invalid_timing`,
   * `blocked_address`, …, `other`) precisely so it can never carry an address
   * or an RPC URL.
   *
   * Note the distinction it makes visible: `ok: false` with no `error` means the
   * operation RESOLVED and came back negative; `error` set means it blew up.
   * Before this existed the second case produced no event at all.
   */
  error?: string;
}

/** Raised when the stream cannot be opened. Carries the HTTP status. */
export class TrafficStreamError extends Error {
  readonly status: number;
  /** Seconds to wait before retrying, when the server said so (503). */
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = 'TrafficStreamError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface StreamTrafficEventsOptions {
  /** Facilitator to subscribe to. Defaults to the Ultravioleta DAO facilitator. */
  facilitatorUrl?: string;
  /**
   * Only yield events for these networks. Applied client-side — the facilitator
   * has no per-network filter, so every event still crosses the wire. Match the
   * canonical slug (`skale-base`, not `skale`).
   */
  networks?: string[];
  /** Only yield these operations. */
  kinds?: TrafficEventKind[];
  /** Abort the stream. Without one, iteration ends only when the server closes. */
  signal?: AbortSignal;
  /** Extra headers, for a deployment that gates the stream behind authorization. */
  headers?: Record<string, string>;
}

/** One decoded SSE frame: the event name and its raw data payload. */
export interface SSEFrame {
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser.
 *
 * Kept separate from the network layer so the framing can be tested without a
 * socket — which matters, because the case that breaks in production is an idle
 * rail sending nothing but keepalive comments for minutes.
 */
export class SSEParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  /** Feed a chunk of the response body; get back whatever frames completed. */
  push(chunk: string): SSEFrame[] {
    this.buffer += chunk;
    const frames: SSEFrame[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line === '') {
        // Blank line dispatches. A dispatch with no data is a no-op per spec.
        if (this.dataLines.length > 0) {
          frames.push({
            event: this.eventName || 'message',
            data: this.dataLines.join('\n'),
          });
        }
        this.eventName = '';
        this.dataLines = [];
        continue;
      }

      if (line.startsWith(':')) {
        // Comment. This is what a keepalive looks like — deliberately silent.
        continue;
      }

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      // A single leading space after the colon is framing, not value.
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') this.eventName = value;
      else if (field === 'data') this.dataLines.push(value);
      // id / retry: accepted and ignored, so a future facilitator that starts
      // sending them does not break this parser.
    }

    return frames;
  }
}

/**
 * Decode one SSE frame into a {@link TrafficEvent}.
 *
 * Returns null for anything malformed: a single bad message must never tear down
 * a long-lived stream — the connection is worth more than the message.
 */
export function parseTrafficEvent(frame: SSEFrame): TrafficEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const raw = payload as Record<string, unknown>;
  // The SSE event name is authoritative for `kind`; the body carries it too and
  // they agree, but the framing is the contract.
  const kind = (raw.kind as string) || frame.event;

  if (typeof raw.ts !== 'number' || typeof raw.network !== 'string' || typeof raw.ok !== 'boolean') {
    return null;
  }

  const event: TrafficEvent = {
    ts: raw.ts,
    kind,
    network: raw.network,
    ok: raw.ok,
  };
  if (typeof raw.payer === 'string') event.payer = raw.payer;
  if (typeof raw.tx === 'string') event.tx = raw.tx;
  if (typeof raw.amount === 'string') event.amount = raw.amount;
  if (typeof raw.asset === 'string') event.asset = raw.asset;
  if (typeof raw.resource === 'string') event.resource = raw.resource;
  if (typeof raw.payTo === 'string') event.payTo = raw.payTo;
  if (typeof raw.description === 'string') event.description = raw.description;
  if (typeof raw.scheme === 'string') event.scheme = raw.scheme;
  if (typeof raw.error === 'string') event.error = raw.error;
  return event;
}

/** Does this event pass the caller's client-side filters? */
export function matchesFilters(
  event: TrafficEvent,
  options: Pick<StreamTrafficEventsOptions, 'networks' | 'kinds'>
): boolean {
  if (options.kinds && options.kinds.length > 0) {
    if (!options.kinds.some((k) => k.toLowerCase() === event.kind.toLowerCase())) return false;
  }
  if (options.networks && options.networks.length > 0) {
    if (!options.networks.some((n) => n.toLowerCase() === event.network.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/**
 * Subscribe to the facilitator's live traffic stream.
 *
 * Works in Node 18+ and in browsers: it uses `fetch` and the response body
 * stream rather than `EventSource`, so it also works where custom headers are
 * needed (`EventSource` cannot send them).
 *
 * Iteration ends when the server closes the connection or the `signal` aborts.
 * It does NOT reconnect on its own — reconnect policy belongs to the caller, who
 * is the only one who knows whether a gap matters.
 *
 * @throws {TrafficStreamError} 404 when the operator disabled the stream, 503
 * with `retryAfter` when it is at subscriber capacity.
 */
export async function* streamTrafficEvents(
  options: StreamTrafficEventsOptions = {}
): AsyncGenerator<TrafficEvent, void, undefined> {
  const baseUrl = (options.facilitatorUrl || DEFAULT_FACILITATOR_URL).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/events`, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', ...(options.headers || {}) },
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new TrafficStreamError(
        `GET /events is disabled on this facilitator (operator set X402_EVENTS_ENABLED=false): ${body}`,
        404
      );
    }
    if (response.status === 503) {
      const header = response.headers.get('retry-after');
      const retryAfter = header ? Number(header) : undefined;
      throw new TrafficStreamError(
        `GET /events is at subscriber capacity; retry after ${header ?? 'unknown'}s. ` +
          `This is admission control, not an outage.`,
        503,
        Number.isFinite(retryAfter) ? retryAfter : undefined
      );
    }
    throw new TrafficStreamError(`GET /events failed: ${response.status} - ${body}`, response.status);
  }

  if (!response.body) {
    throw new TrafficStreamError('GET /events returned no body to stream', response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        const event = parseTrafficEvent(frame);
        if (event && matchesFilters(event, options)) yield event;
      }
    }
  } finally {
    // Releasing the lock lets the caller's `break` actually close the socket
    // instead of leaking a half-read response.
    reader.releaseLock();
  }
}
