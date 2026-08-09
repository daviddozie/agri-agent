/**
 * uvd-x402-sdk - EnvKeyAdapter
 *
 * SigningWalletAdapter implementation using a raw private key.
 * Reads the key from a constructor parameter or the WALLET_PRIVATE_KEY
 * environment variable.
 *
 * Intended for server-side / CLI / agent use cases where the
 * signing key is available in the environment. NEVER use this
 * in browser contexts -- use OWSWalletAdapter instead.
 *
 * @example Using environment variable
 * ```ts
 * // Reads process.env.WALLET_PRIVATE_KEY
 * const wallet = new EnvKeyAdapter();
 * console.log(wallet.getAddress()); // 0x...
 * ```
 *
 * @example Using explicit key
 * ```ts
 * const wallet = new EnvKeyAdapter(process.env.MY_AGENT_KEY!);
 * const auth = await wallet.signEIP3009({
 *   to: '0xRecipient',
 *   amountUsdc: 0.10,
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

/**
 * EnvKeyAdapter -- SigningWalletAdapter backed by a raw private key.
 */
export class EnvKeyAdapter implements SigningWalletAdapter {
  private readonly wallet: ethers.Wallet;

  /**
   * Create an EnvKeyAdapter.
   *
   * @param privateKey - Hex-encoded private key (with or without 0x prefix).
   *   If omitted, reads from `process.env.WALLET_PRIVATE_KEY`.
   * @throws {X402Error} if no private key is available
   */
  constructor(privateKey?: string) {
    const key = privateKey || (typeof process !== 'undefined' ? process.env.WALLET_PRIVATE_KEY : undefined);

    if (!key) {
      throw new X402Error(
        'No private key provided. Pass it to the constructor or set WALLET_PRIVATE_KEY env var.',
        'WALLET_NOT_CONNECTED',
      );
    }

    this.wallet = new ethers.Wallet(key);
  }

  /**
   * Get the checksummed EVM wallet address.
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Sign a message using EIP-191 personal_sign.
   *
   * @param message - The message string to sign
   * @returns Hex-encoded signature
   */
  async signMessage(message: string): Promise<string> {
    return this.wallet.signMessage(message);
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
      domain: ethers.TypedDataDomain;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    };

    // ethers v6 signTypedData does not take primaryType -- it infers it
    // from the types object (the type not listed as a field of another type).
    // We pass domain, types (without EIP712Domain), and the message value.
    const { domain, types, message } = parsed;

    // Remove EIP712Domain from types if present (ethers handles it via domain)
    const cleanTypes = { ...types };
    delete cleanTypes['EIP712Domain'];

    const signature = await this.wallet.signTypedData(domain, cleanTypes, message);
    const sig = ethers.Signature.from(signature);

    return {
      signature,
      v: sig.v,
      r: sig.r,
      s: sig.s,
    };
  }

  /**
   * Sign a serialized EVM transaction.
   *
   * Uses the raw private key via ethers.Wallet.signTransaction().
   * Used by AdvancedEscrowClient for on-chain operations (release,
   * refund, charge) when constructed with a SigningWalletAdapter.
   *
   * @param unsignedTx - Hex-encoded unsigned transaction (ethers serialized)
   * @returns Hex-encoded signed raw transaction, ready for broadcast
   */
  async signTransaction(unsignedTx: string): Promise<string> {
    const tx = ethers.Transaction.from(unsignedTx);
    return this.wallet.signTransaction(tx);
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
    const from = this.wallet.address;
    const to = ethers.getAddress(params.to);
    const value = ethers.parseUnits(params.amountUsdc.toString(), chain.usdc.decimals);
    const validAfter = params.validAfter ?? 0;
    const validBefore = params.validBefore ?? Math.floor(Date.now() / 1000) + 300;

    // Generate random 32-byte nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // EIP-712 domain (matches USDC contract's domain separator)
    const domain: ethers.TypedDataDomain = {
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
    const message = {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    };

    // Sign the EIP-712 typed data
    let signature: string;
    try {
      signature = await this.wallet.signTypedData(domain, types, message);
    } catch (error: unknown) {
      throw new X402Error(
        `Failed to sign EIP-3009 authorization: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error,
      );
    }

    const sig = ethers.Signature.from(signature);

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
      signature,
    };
  }
}
