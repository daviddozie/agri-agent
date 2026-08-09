/**
 * uvd-x402-sdk - x402 Protocol Utilities
 *
 * Utilities for working with x402 v1 and v2 protocols.
 * Handles version detection, payload encoding, and CAIP-2 conversions.
 */

import type {
  X402Header,
  X402HeaderV1,
  X402HeaderV2,
  X402PayloadData,
  X402PaymentOption,
  X402Version,
  ChainConfig,
} from '../types';
import { CAIP2_IDENTIFIERS, CAIP2_TO_CHAIN } from '../types';
import { getChainByName } from '../chains';
import { decodeBase64Utf8, encodeBase64Json } from './base64';

/**
 * Detect x402 version from a response header or body
 *
 * @param data - The 402 response data (parsed JSON or header value)
 * @returns The detected version (1 or 2)
 */
export function detectX402Version(data: unknown): X402Version {
  if (typeof data !== 'object' || data === null) {
    return 1; // Default to v1
  }

  const obj = data as Record<string, unknown>;

  // Check explicit version field
  if (obj.x402Version === 2) {
    return 2;
  }

  // Check for v2 indicators
  if (obj.accepts && Array.isArray(obj.accepts)) {
    return 2;
  }

  // Check if network is in CAIP-2 format
  if (typeof obj.network === 'string') {
    if (obj.network.includes(':')) {
      return 2;
    }
  }

  return 1;
}

/**
 * Convert chain name to CAIP-2 identifier
 *
 * @param chainName - Chain name (e.g., 'base', 'solana')
 * @returns CAIP-2 identifier (e.g., 'eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
 */
export function chainToCAIP2(chainName: string): string {
  const caip2 = CAIP2_IDENTIFIERS[chainName.toLowerCase()];
  if (caip2) {
    return caip2;
  }

  // Try to construct from chain config
  const chain = getChainByName(chainName);
  if (chain) {
    if (chain.networkType === 'evm') {
      return `eip155:${chain.chainId}`;
    }
    // For non-EVM, return the name as-is with network prefix
    return `${chain.networkType}:${chainName}`;
  }

  return chainName; // Return as-is if unknown
}

/**
 * Convert CAIP-2 identifier to chain name
 *
 * @param caip2 - CAIP-2 identifier
 * @returns Chain name or null if unknown
 */
export function caip2ToChain(caip2: string): string | null {
  // Check direct mapping
  if (CAIP2_TO_CHAIN[caip2]) {
    return CAIP2_TO_CHAIN[caip2];
  }

  // Try to extract from EIP-155 format
  const match = caip2.match(/^eip155:(\d+)$/);
  if (match) {
    const chainId = parseInt(match[1], 10);
    // Find chain by ID
    for (const [name, _config] of Object.entries(CAIP2_IDENTIFIERS)) {
      const chain = getChainByName(name);
      if (chain?.chainId === chainId) {
        return name;
      }
    }
  }

  // Try to extract from network:name format
  const parts = caip2.split(':');
  if (parts.length === 2) {
    const networkName = parts[1];
    if (getChainByName(networkName)) {
      return networkName;
    }
  }

  return null;
}

/**
 * Parse network identifier from either v1 or v2 format
 *
 * @param network - Network identifier (v1 string or v2 CAIP-2)
 * @returns Normalized chain name
 */
export function parseNetworkIdentifier(network: string): string {
  // If it contains a colon, it's likely CAIP-2
  if (network.includes(':')) {
    return caip2ToChain(network) || network;
  }
  return network.toLowerCase();
}

/**
 * Encode x402 payload as base64 header value
 *
 * @param header - The x402 header object
 * @returns Base64-encoded string
 */
export function encodeX402Header(header: X402Header): string {
  return encodeBase64Json(header);
}

/**
 * Decode x402 header from base64 string
 *
 * @param encoded - Base64-encoded header value
 * @returns Parsed x402 header
 */
export function decodeX402Header(encoded: string): X402Header {
  const json = decodeBase64Utf8(encoded);
  return JSON.parse(json) as X402Header;
}

/**
 * Create x402 v1 header
 *
 * @param network - Chain name (e.g., 'base')
 * @param payload - Network-specific payload
 * @returns x402 v1 header object
 */
export function createX402V1Header(
  network: string,
  payload: X402PayloadData
): X402HeaderV1 {
  return {
    x402Version: 1,
    scheme: 'exact',
    network,
    payload,
  };
}

/**
 * Create x402 v2 header
 *
 * @param network - CAIP-2 network identifier
 * @param payload - Network-specific payload
 * @param accepts - Optional array of payment options
 * @returns x402 v2 header object
 */
export function createX402V2Header(
  network: string,
  payload: X402PayloadData,
  accepts?: X402PaymentOption[]
): X402HeaderV2 {
  const header: X402HeaderV2 = {
    x402Version: 2,
    scheme: 'exact',
    network: network.includes(':') ? network : chainToCAIP2(network),
    payload,
  };

  if (accepts && accepts.length > 0) {
    header.accepts = accepts;
  }

  return header;
}

/**
 * Create x402 header with automatic version selection
 *
 * @param chainConfig - Chain configuration
 * @param payload - Network-specific payload
 * @param version - Version to use (1, 2, or 'auto')
 * @returns x402 header object
 */
export function createX402Header(
  chainConfig: ChainConfig,
  payload: X402PayloadData,
  version: X402Version | 'auto' = 'auto'
): X402Header {
  // Default to v1 for maximum compatibility
  const effectiveVersion = version === 'auto' ? 1 : version;

  if (effectiveVersion === 2) {
    return createX402V2Header(chainConfig.name, payload);
  }

  return createX402V1Header(chainConfig.name, payload);
}

/**
 * Generate payment options array for multi-network support
 *
 * @param chainConfigs - Array of chain configurations
 * @param amount - Amount in USDC (e.g., "10.00")
 * @param facilitator - Optional facilitator URL override
 * @returns Array of x402 v2 payment options
 */
export function generatePaymentOptions(
  chainConfigs: ChainConfig[],
  amount: string,
  facilitator?: string
): X402PaymentOption[] {
  // Convert amount to atomic units for each chain
  return chainConfigs
    .filter(chain => chain.x402.enabled)
    .map(chain => {
      const atomicAmount = Math.floor(
        parseFloat(amount) * Math.pow(10, chain.usdc.decimals)
      ).toString();

      return {
        network: chainToCAIP2(chain.name),
        asset: chain.usdc.address,
        amount: atomicAmount,
        facilitator: facilitator || chain.x402.facilitatorUrl,
      };
    });
}

/**
 * Check if a network string is in CAIP-2 format
 *
 * @param network - Network identifier
 * @returns True if CAIP-2 format
 */
export function isCAIP2Format(network: string): boolean {
  return network.includes(':');
}

/**
 * Convert between x402 v1 and v2 header formats
 *
 * @param header - Source header
 * @param targetVersion - Target version
 * @returns Converted header
 */
export function convertX402Header(
  header: X402Header,
  targetVersion: X402Version
): X402Header {
  if (header.x402Version === targetVersion) {
    return header;
  }

  if (targetVersion === 2) {
    // v1 -> v2
    return {
      x402Version: 2,
      scheme: 'exact',
      network: chainToCAIP2(header.network),
      payload: header.payload,
    };
  } else {
    // v2 -> v1
    const chainName = isCAIP2Format(header.network)
      ? caip2ToChain(header.network) || header.network
      : header.network;

    return {
      x402Version: 1,
      scheme: 'exact',
      network: chainName,
      payload: header.payload,
    };
  }
}
