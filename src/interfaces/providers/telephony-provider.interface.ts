/**
 * telephony-provider.interface.ts
 *
 * Contract that ANY telephony vendor (Plivo today, others tomorrow)
 * must satisfy to be plugged into the Provider Registry. The
 * VoiceSessionManager depends only on this interface — never on a
 * concrete vendor SDK.
 */

import type { ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type { SessionId } from "../../types/session.types";
import type { TelephonyMediaStream } from "../../types/streaming.types";

/**
 * Parameters required to place or accept a telephony call.
 * Kept minimal and vendor-neutral; vendor-specific call options are
 * the responsibility of the concrete implementation's own config.
 */
export interface TelephonyCallParams {
  readonly sessionId: SessionId;
  readonly destinationNumber?: string;
}

/**
 * Handle representing an active call, returned by a
 * TelephonyProvider so the VoiceSessionManager can reference it in
 * subsequent operations without knowing the vendor's internal
 * call representation.
 */
export interface TelephonyCallHandle {
  readonly sessionId: SessionId;
  readonly providerCallId: string;
}

export interface TelephonyProvider {
  /**
   * Static description of this provider implementation used by the
   * Provider Registry for discovery/listing.
   */
  readonly descriptor: ProviderDescriptor;

  /**
   * Initiate an outbound call or prepare to accept an inbound call
   * for the given session.
   */
  startCall(params: TelephonyCallParams): Promise<TelephonyCallHandle>;

  /**
   * Terminate an in-progress call associated with the given handle.
   */
  endCall(handle: TelephonyCallHandle): Promise<void>;

  /**
   * OPTIONAL, ADDITIVE. Open a duplex media handle over an
   * already-started call, giving the caller a vendor-neutral way to
   * receive inbound audio and push outbound audio in real time. A
   * provider that does not implement media streaming (e.g. because
   * it only wires call control today) simply omits this member;
   * callers must feature-detect it (`if (provider.openMediaStream)`)
   * before relying on real-time audio duplexing. Does not replace or
   * alter the semantics of `startCall`/`endCall`.
   */
  openMediaStream?(handle: TelephonyCallHandle): Promise<TelephonyMediaStream>;

  /**
   * Report whether the provider's upstream connection is currently
   * reachable and authenticated.
   */
  checkHealth(): Promise<ProviderHealthStatus>;
}
