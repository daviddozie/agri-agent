/**
 * uvd-x402-sdk - OWSWalletAdapter
 *
 * SigningWalletAdapter implementation using the Open Wallet Standard (OWS).
 * Delegates all signing to an OWS wallet instance, which manages key
 * security (encrypted vault, hardware isolation, etc.).
 *
 * Requires `@open-wallet-standard/core` as an optional peer dependency.
 * If the package is not installed, the adapter throws a helpful error
 * at construction time.
 *
 * @example
 * ```ts
 * import { OWSWalletAdapter } from 'uvd-x402-sdk';
 *
 * // The OWS wallet object must implement signMessage and signTypedData
 * const wallet = new OWSWalletAdapter(owsWallet);
 * const auth = await wallet.signEIP3009({
 *   to: '0xRecipient',
 *   amountUsdc: 0.50,
 *   network: 'base',
 * });
 * ```
 */

import { ethers } from 'ethers';
import { getChainByName } from '../chains';
import { X402Error } from '../types';
import type {
  SigningWalletAdapter,
  EIP3009Params,
  EIP3009Authorization,
} from '../wallet';

// ============================================================================
// OWS WALLET INTERFACE (minimal subset we need)
// ============================================================================

/**
 * Minimal OWS wallet interface for signing operations.
 *
 * This mirrors the subset of the Open Wallet Standard that we use,
 * avoiding a hard compile-time dependency on @open-wallet-standard/core.
 * Any object that satisfies this shape can be passed to OWSWalletAdapter.
 */
export interface OWSWallet {
  /** Get wallet accounts (at least one EVM account expected) */
  accounts: ReadonlyArray<{
    /** EVM address (0x...) */
    address: string;
    /** Chain identifiers this account supports */
    chains?: ReadonlyArray<string>;
  }>;

  /** Sign a personal message (EIP-191) */
  signMessage(params: {
    account: { address: string };
    message: string | Uint8Array;
  }): Promise<{ signature: string }>;

  /** Sign EIP-712 typed data */
  signTypedData(params: {
    account: { address: string };
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<{ signature: string }>;

  /** Sign a serialized EVM transaction (hex-encoded) */
  signTransaction(params: {
    account: { address: string };
    transaction: string;
    chainId: string;
  }): Promise<{ signedTransaction: string }>;
}

// ============================================================================
// OWS WALLET ADAPTER
// ============================================================================

/**
 * OWSWalletAdapter -- SigningWalletAdapter backed by an Open Wallet Standard wallet.
 */
export class OWSWalletAdapter implements SigningWalletAdapter {
  private readonly owsWallet: OWSWallet;
  private readonly address: string;

  /**
   * Create an OWSWalletAdapter.
   *
   * @param owsWallet - An object implementing the OWSWallet interface
   *   (typically from @open-wallet-standard/core or a compatible provider)
   * @param accountIndex - Which account to use if the wallet has multiple (default: 0)
   * @throws {X402Error} if the wallet has no accounts
   */
  constructor(owsWallet: OWSWallet, accountIndex = 0) {
    if (!owsWallet || !owsWallet.accounts || owsWallet.accounts.length === 0) {
      throw new X402Error(
        'OWS wallet has no accounts. Create or import a wallet first.',
        'WALLET_NOT_CONNECTED',
      );
    }

    const account = owsWallet.accounts[accountIndex];
    if (!account) {
      throw new X402Error(
        `OWS wallet account index ${accountIndex} does not exist. Wallet has ${owsWallet.accounts.length} account(s).`,
        'WALLET_NOT_CONNECTED',
      );
    }

    this.owsWallet = owsWallet;
    this.address = ethers.getAddress(account.address);
  }

  /**
   * Get the checksummed EVM wallet address.
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Sign a message using EIP-191 personal_sign.
   *
   * @param message - The message string to sign
   * @returns Hex-encoded signature
   */
  async signMessage(message: string): Promise<string> {
    try {
      const result = await this.owsWallet.signMessage({
        account: { address: this.address },
        message,
      });
      return result.signature;
    } catch (error: unknown) {
      throw new X402Error(
        `OWS signMessage failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error,
      );
    }
  }

  /**
   * Sign EIP-712 typed structured data.
   *
   * @param typedData - JSON string with `domain`, `types`, `primaryType`, and `message` fields
   * @returns Object with signature and v/r/s components
   */
  async signTypedData(typedData: string): Promise<{
    signature: string;
    v: number;
    r: string;
    s: string;
  }> {
    const parsed = JSON.parse(typedData) as {
      domain: Record<string, unknown>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    };

    try {
      const result = await this.owsWallet.signTypedData({
        account: { address: this.address },
        domain: parsed.domain,
        types: parsed.types,
        primaryType: parsed.primaryType,
        message: parsed.message,
      });

      const sig = ethers.Signature.from(result.signature);

      return {
        signature: result.signature,
        v: sig.v,
        r: sig.r,
        s: sig.s,
      };
    } catch (error: unknown) {
      throw new X402Error(
        `OWS signTypedData failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error,
      );
    }
  }

  /**
   * Sign a serialized EVM transaction.
   *
   * Delegates to the OWS wallet's signTransaction method.
   * Used by AdvancedEscrowClient for on-chain operations (release,
   * refund, charge) where the wallet signs instead of a raw private key.
   *
   * @param unsignedTx - Hex-encoded unsigned transaction
   * @returns Hex-encoded signed raw transaction
   */
  async signTransaction(unsignedTx: string): Promise<string> {
    try {
      const result = await this.owsWallet.signTransaction({
        account: { address: this.address },
        transaction: unsignedTx,
        chainId: '1', // chainId is embedded in the serialized TX; this is a hint
      });
      return result.signedTransaction;
    } catch (error: unknown) {
      throw new X402Error(
        `OWS signTransaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error,
      );
    }
  }

  /**
   * Sign an EIP-3009 ReceiveWithAuthorization for USDC.
   *
   * @param params - EIP-3009 parameters
   * @returns Signed authorization ready for facilitator relay
   */
  async signEIP3009(params: EIP3009Params): Promise<EIP3009Authorization> {
    const chain = getChainByName(params.network);
    if (!chain) {
      throw new X402Error(`Unsupported network: ${params.network}`, 'CHAIN_NOT_SUPPORTED');
    }

    if (chain.networkType !== 'evm') {
      throw new X402Error(
        `EIP-3009 is only supported on EVM chains. ${params.network} is ${chain.networkType}.`,
        'CHAIN_NOT_SUPPORTED',
      );
    }

    const chainId = params.chainId ?? chain.chainId;
    const usdcAddress = params.usdcContract ?? chain.usdc.address;
    const from = this.address;
    const to = ethers.getAddress(params.to);
    const value = ethers.parseUnits(params.amountUsdc.toString(), chain.usdc.decimals);
    const validAfter = params.validAfter ?? 0;
    const validBefore = params.validBefore ?? Math.floor(Date.now() / 1000) + 300;

    // Generate random 32-byte nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // EIP-712 domain
    const domain: Record<string, unknown> = {
      name: chain.usdc.name,
      version: chain.usdc.version,
      chainId,
      verifyingContract: usdcAddress,
    };

    // EIP-712 types for TransferWithAuthorization (ERC-3009)
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };

    // Message to sign
    const message: Record<string, unknown> = {
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    };

    let signatureResult: { signature: string };
    try {
      signatureResult = await this.owsWallet.signTypedData({
        account: { address: this.address },
        domain,
        types,
        primaryType: 'TransferWithAuthorization',
        message,
      });
    } catch (error: unknown) {
      throw new X402Error(
        `OWS signEIP3009 failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error,
      );
    }

    const sig = ethers.Signature.from(signatureResult.signature);

    return {
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      v: sig.v,
      r: sig.r,
      s: sig.s,
      signature: signatureResult.signature,
    };
  }
}
