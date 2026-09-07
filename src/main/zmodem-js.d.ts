/**
 * Minimal ambient typings for the `zmodem.js` package (v0.1.10).
 *
 * zmodem.js ships no type declarations and `@types/zmodem.js` is not installed;
 * npm install is out of scope here, so this file declares exactly the surface
 * src/main/zmodem.ts consumes. Verified against the sources in
 * node_modules/zmodem.js/src/{zsentry,zsession,zvalidation,zheader}.js:
 *
 *  - Sentry.consume() accepts a Uint8Array / ArrayBuffer / octet Array.
 *  - Detection.confirm() returns the matched Session; the Session's `.type`
 *    is "receive" (remote `sz` -> we download) or "send" (remote `rz` -> we
 *    upload).
 *  - The byte arrays passed to `to_terminal` / `sender` are plain number[].
 */
declare module 'zmodem.js' {
  /** one batch of a file being received (see Offer) */
  export interface FileDetails {
    name: string
    /** can be null when the peer streams an unknown size; zmodem.js accepts */
    size?: number | null
    /** POSIX mode bits (0x8000 | perm); optional */
    mode?: number | null
    /** Date or epoch seconds; optional */
    mtime?: Date | number | null
    files_remaining?: number | null
    bytes_remaining?: number | null
  }

  /** A sender-side single-file transfer handle (result of send_offer()). */
  export interface Transfer {
    get_details(): FileDetails
    get_offset(): number
    /** Send a non-terminal chunk. */
    send(arrayLike: number[] | Uint8Array): void
    /** Send the terminal chunk; resolves when the receiver confirms file end. */
    end(arrayLike?: number[] | Uint8Array): Promise<void>
  }

  /** A receiver-side offerable file (shown on a receive Session's "offer"). */
  export interface Offer {
    get_details(): FileDetails
    get_offset(): number
    /** Skip this file (not an error, unlike abort()). */
    skip(): Promise<never>
    /**
     * Accept the offer. With { on_input: fn } the payload of every data
     * subpacket is delivered to `fn` (streaming, no full spool in memory).
     */
    accept(opts?: {
      offset?: number
      on_input?: 'spool_array' | 'spool_uint8array' | ((payload: Uint8Array) => void)
    }): Promise<unknown>
    on(event: 'input', cb: (payload: Uint8Array) => void): Offer
    on(event: 'complete', cb: () => void): Offer
  }

  /** Base ZMODEM session (Send/Receive share this). */
  export interface Session {
    type: 'send' | 'receive'
    set_sender(fn: (octets: number[]) => void): void
    has_ended(): boolean
    aborted(): boolean
    /** Abort the transfer (sends the ZMODEM CAN sequence to the peer). */
    abort(): void
    /** Register a session_end handler (fires once the transfer is done). */
    on(event: 'session_end', cb: () => void): void
    /** Catch-all overload (keeps the Send|Receive union from collapsing to never). */
    on(event: never, cb: (...args: unknown[]) => void): void
  }

  /** Send session (we upload, remote ran rz). */
  export interface SendSession extends Session {
    type: 'send'
    /** Offer one file; resolves with the Transfer or undefined if skipped. */
    send_offer(params: FileDetails): Promise<Transfer | undefined>
    /** Ends a send session gracefully; resolves when the receiver acks ZFIN. */
    close(): Promise<void>
  }

  /** Receive session (we download, remote ran sz). */
  export interface ReceiveSession extends Session {
    type: 'receive'
    on(event: 'offer', cb: (offer: Offer) => void): void
    /** Begin receiving: tells the peer we are ready for the first offer. */
    start(): Promise<void>
  }

  export interface SentryOptions {
    /** Non-ZMODEM octets to forward to the terminal. */
    to_terminal(octets: number[]): void
    /** Called with a Detection when a ZMODEM header is spotted. */
    on_detect(detection: Detection): void
    /** Called when a pending Detection is retracted (no session after all). */
    on_retract(): void
    /** Send octets to the peer (the ssh stream). */
    sender(octets: number[]): void
  }

  export interface Detection {
    /** Whether the detection is still valid (not retracted). */
    is_valid(): boolean
    /** Confirm the ZMODEM session and return the active Session object. */
    confirm(): SendSession | ReceiveSession
    /** Give the session's role: 'send' or 'receive'. */
    get_session_role(): 'send' | 'receive'
    /** Reject: tell the peer to abort the session. */
    deny(): void
  }

  export const Sentry: new (options: SentryOptions) => Sentry
  export interface Sentry {
    consume(input: Uint8Array | ArrayBuffer | number[]): void
    get_confirmed_session(): Session | null
  }

  export const ZMLIB: { ABORT_SEQUENCE: number[] }
  export const ZDLE: new () => unknown
  export const CRC: { crc16(input: ArrayLike<number>): number }
  export const Header: Record<string, unknown>
  export const Subpacket: Record<string, unknown>
  export const Session: {
    Send: new (zrinitHeader: unknown) => SendSession
    Receive: new () => ReceiveSession
  }
}