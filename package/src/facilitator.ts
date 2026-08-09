/**
 * Facilitator Configuration
 *
 * This module contains the known facilitator addresses for each chain.
 * The SDK uses these automatically so users don't need to configure them.
 *
 * The facilitator (https://facilitator.ultravioletadao.xyz) has wallets
 * on each supported blockchain for:
 * - EVM: Signing EIP-3009 transferWithAuthorization transactions
 * - Solana: Paying transaction fees (fee payer)
 * - Algorand: Signing fee transactions in atomic groups
 * - Stellar: Signing authorization entries
 * - NEAR: Acting as relayer for meta-transactions
 * - Sui: Sponsoring transactions (paying gas via sponsored txs)
 * - XRPL: Submitting pre-signed Payment blobs (paying the network fee)
 */

/**
 * Default facilitator URL
 */
export const DEFAULT_FACILITATOR_URL = 'https://facilitator.ultravioletadao.xyz';

/**
 * Facilitator wallet addresses by chain type
 *
 * These are the public addresses of the facilitator's wallets.
 * The facilitator uses these to pay fees and sign transactions.
 */
export const FACILITATOR_ADDRESSES = {
  // ============================================
  // EVM Chains
  // ============================================
  /**
   * EVM facilitator address (mainnet)
   * Used for: Submitting EIP-3009 transferWithAuthorization transactions
   * Note: Same address across all EVM mainnet chains
   */
  evm: '0x103040545AC5031A11E8C03dd11324C7333a13C7',

  /**
   * EVM facilitator address (testnet)
   * Used for: All EVM testnet chains
   */
  'evm-testnet': '0x34033041a5944B8F10f8E4D8496Bfb84f1A293A8',

  // ============================================
  // Solana
  // ============================================
  /**
   * Solana facilitator address (mainnet)
   * Used for: Paying transaction fees on Solana
   */
  solana: 'F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq',

  /**
   * Solana facilitator address (devnet)
   */
  'solana-devnet': '6xNPewUdKRbEZDReQdpyfNUdgNg8QRc8Mt263T5GZSRv',

  // ============================================
  // Fogo (uses same addresses as Solana)
  // ============================================
  /**
   * Fogo facilitator address (mainnet)
   */
  fogo: 'F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq',

  /**
   * Fogo facilitator address (testnet)
   */
  'fogo-testnet': '6xNPewUdKRbEZDReQdpyfNUdgNg8QRc8Mt263T5GZSRv',

  // ============================================
  // NEAR
  // ============================================
  /**
   * NEAR facilitator address (mainnet)
   * Used for: Relaying meta-transactions
   */
  near: 'uvd-facilitator.near',

  /**
   * NEAR facilitator address (testnet)
   */
  'near-testnet': 'uvd-facilitator.testnet',

  // ============================================
  // Stellar
  // ============================================
  /**
   * Stellar facilitator address (mainnet)
   * Used for: Signing soroban authorization entries
   */
  stellar: 'GCHPGXJT2WFFRFCA5TV4G4E3PMMXLNIDUH27PKDYA4QJ2XGYZWGFZNHB',

  /**
   * Stellar facilitator address (testnet)
   */
  'stellar-testnet': 'GBBFZMLUJEZVI32EN4XA2KPP445XIBTMTRBLYWFIL556RDTHS2OWFQ2Z',

  // ============================================
  // Algorand
  // ============================================
  /**
   * Algorand facilitator address (mainnet)
   * Used for: Signing Transaction 0 (fee tx) in atomic groups
   */
  algorand: 'KIMS5H6QLCUDL65L5UBTOXDPWLMTS7N3AAC3I6B2NCONEI5QIVK7LH2C2I',

  /**
   * Algorand facilitator address (testnet)
   */
  'algorand-testnet': '5DPPDQNYUPCTXRZWRYSF3WPYU6RKAUR25F3YG4EKXQRHV5AUAI62H5GXL4',

  // ============================================
  // Sui
  // ============================================
  /**
   * Sui facilitator address (mainnet)
   * Used for: Sponsoring transactions (paying gas)
   */
  sui: '0xe7bbf2b13f7d72714760aa16e024fa1b35a978793f9893d0568a4fbf356a764a',

  /**
   * Sui facilitator address (testnet)
   */
  'sui-testnet': '0xabbd16a2fab2a502c9cfe835195a6fc7d70bfc27cffb40b8b286b52a97006e67',

  // ============================================
  // XRPL (XRP Ledger)
  // ============================================
  /**
   * XRPL facilitator address (mainnet)
   * Used for: Submitting pre-signed Payment blobs and paying the network fee
   */
  'xrpl-mainnet': 'rfADKkVXBNqK3z72tVSS3LVzAR3psYkonp',

  /**
   * XRPL facilitator address (testnet)
   */
  'xrpl-testnet': 'rGhTioKAFHe75KgVnQtacRiKFuPv28Wbwk',
} as const;

/**
 * Get the facilitator address for a specific chain
 *
 * @param chainName - The chain name (e.g., 'algorand', 'solana', 'base')
 * @param networkType - The network type (e.g., 'evm', 'svm', 'algorand')
 * @returns The facilitator address for that chain, or undefined if not supported
 */
export function getFacilitatorAddress(
  chainName: string,
  networkType?: string
): string | undefined {
  // Check for exact chain match first
  const exactMatch = FACILITATOR_ADDRESSES[chainName as keyof typeof FACILITATOR_ADDRESSES];
  if (exactMatch) {
    return exactMatch;
  }

  // Fall back to network type
  if (networkType === 'evm') {
    return FACILITATOR_ADDRESSES.evm;
  }
  if (networkType === 'svm' || networkType === 'solana') {
    return FACILITATOR_ADDRESSES.solana;
  }
  if (networkType === 'algorand') {
    return FACILITATOR_ADDRESSES.algorand;
  }
  if (networkType === 'stellar') {
    return FACILITATOR_ADDRESSES.stellar;
  }
  if (networkType === 'near') {
    return FACILITATOR_ADDRESSES.near;
  }
  if (networkType === 'sui') {
    return FACILITATOR_ADDRESSES.sui;
  }
  if (networkType === 'xrpl') {
    return FACILITATOR_ADDRESSES['xrpl-mainnet'];
  }

  return undefined;
}

/**
 * Type for facilitator addresses
 */
export type FacilitatorAddresses = typeof FACILITATOR_ADDRESSES;
