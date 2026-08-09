/**
 * uvd-x402-sdk - Token metadata for payment payloads
 *
 * An EIP-3009 authorization is signed against a token contract, but the encoded
 * payload only carries the signature and the transfer fields. The token itself
 * is implicit — the server is expected to already know which asset it asked
 * for.
 *
 * That holds when a resource accepts exactly one token per chain. It breaks as
 * soon as it accepts several: a EURC payment and a USDC payment on Base produce
 * indistinguishable payloads, and the server cannot build the
 * `paymentRequirements` (`asset` + `extra`) the facilitator needs to settle.
 *
 * So the payment can opt into carrying the token with it.
 */

import { getTokenByAddress } from '../chains';
import type { PaymentTokenMetadata } from '../types';

/**
 * Build the token metadata block for a payload, resolving the address against
 * the chain registry.
 *
 * @param chainName - Chain the payment was signed for
 * @param address - Token contract address from the signed payload
 * @returns Metadata block, or undefined if the address is not in the registry
 */
export function buildTokenMetadata(
  chainName: string,
  address: string
): PaymentTokenMetadata | undefined {
  const match = getTokenByAddress(chainName, address);
  if (!match) return undefined;

  return {
    address: match.config.address,
    symbol: match.tokenType.toUpperCase(),
    decimals: match.config.decimals,
    eip712: {
      name: match.config.name,
      version: match.config.version,
    },
  };
}
