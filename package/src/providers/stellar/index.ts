/**
 * uvd-x402-sdk - Stellar Provider
 *
 * Provides Stellar wallet connection and payment creation via Freighter.
 * Uses Soroban authorization entries for gasless USDC transfers.
 *
 * @example
 * ```ts
 * import { X402Client } from 'uvd-x402-sdk';
 * import { StellarProvider } from 'uvd-x402-sdk/stellar';
 *
 * const client = new X402Client();
 * const stellar = new StellarProvider();
 *
 * // Connect
 * const address = await stellar.connect();
 *
 * // Create payment
 * const paymentPayload = await stellar.createPayment(paymentInfo);
 * ```
 */

import type {
  ChainConfig,
  PaymentInfo,
  StellarPaymentPayload,
  WalletAdapter,
  X402Version,
} from '../../types';
import { X402Error } from '../../types';
import { chainToCAIP2, encodeBase64Json } from '../../utils';

/**
 * Browser-compatible text to Uint8Array encoding
 * Avoids Node.js Buffer dependency for browser bundlers
 */
function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Browser-compatible base64 decoding to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Stellar configuration
const STELLAR_CONFIG = {
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  horizonUrl: 'https://horizon.stellar.org',
  sorobanRpcUrl: 'https://mainnet.sorobanrpc.com',
  usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

/**
 * StellarProvider - Wallet adapter for Stellar via Freighter
 */
export class StellarProvider implements WalletAdapter {
  readonly id = 'freighter';
  readonly name = 'Freighter';
  readonly networkType = 'stellar' as const;

  private publicKey: string | null = null;

  /**
   * Check if Freighter wallet is available
   */
  isAvailable(): boolean {
    if (typeof window === 'undefined') return false;
    // Check for Freighter global
    return typeof (window as Window & { freighter?: unknown }).freighter !== 'undefined';
  }

  /**
   * Connect to Freighter wallet
   */
  async connect(): Promise<string> {
    const freighterApi = await this.getFreighterApi();

    try {
      // Check if Freighter is connected
      const connectionResult = await freighterApi.isConnected();
      if (!connectionResult.isConnected) {
        throw new X402Error(
          'Freighter wallet not installed. Please install from freighter.app',
          'WALLET_NOT_FOUND'
        );
      }

      // Request access
      const accessResult = await freighterApi.requestAccess();
      if (accessResult.error) {
        throw new X402Error(accessResult.error, 'WALLET_CONNECTION_REJECTED');
      }

      // Get address
      const addressResult = await freighterApi.getAddress();
      if (addressResult.error) {
        throw new X402Error(addressResult.error, 'WALLET_CONNECTION_REJECTED');
      }

      const address = addressResult.address;
      if (!address) {
        throw new X402Error('Failed to get Stellar public key', 'WALLET_CONNECTION_REJECTED');
      }

      // Validate format (G... public key)
      if (!address.startsWith('G') || address.length !== 56) {
        throw new X402Error('Invalid Stellar public key format', 'WALLET_CONNECTION_REJECTED');
      }

      this.publicKey = address;
      return address;
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;

      if (error instanceof Error) {
        if (error.message.includes('User rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }

      throw new X402Error(
        `Failed to connect Freighter: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Disconnect from Freighter
   */
  async disconnect(): Promise<void> {
    this.publicKey = null;
  }

  /**
   * Get current address
   */
  getAddress(): string | null {
    return this.publicKey;
  }

  /**
   * Get USDC balance
   */
  async getBalance(_chainConfig: ChainConfig): Promise<string> {
    if (!this.publicKey) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    try {
      const response = await fetch(
        `${STELLAR_CONFIG.horizonUrl}/accounts/${this.publicKey}`
      );

      if (!response.ok) {
        if (response.status === 404) {
          // Account not activated
          return '0.00';
        }
        throw new Error('Failed to fetch Stellar account');
      }

      const account = await response.json();

      // Find USDC balance
      const usdcBalance = account.balances.find(
        (b: { asset_code?: string; asset_issuer?: string }) =>
          b.asset_code === 'USDC' && b.asset_issuer === STELLAR_CONFIG.usdcIssuer
      );

      if (!usdcBalance) {
        return '0.00';
      }

      const balance = parseFloat(usdcBalance.balance);
      return balance.toFixed(2);
    } catch {
      return '0.00';
    }
  }

  /**
   * Create Stellar payment (Soroban authorization entry)
   *
   * User signs an authorization that proves they authorized the USDC transfer.
   * Facilitator wraps this in a fee-bump transaction and pays all XLM network fees.
   */
  async signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string> {
    if (!this.publicKey) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const freighterApi = await this.getFreighterApi();
    const stellarSdk = await import('@stellar/stellar-sdk');
    const { Address, xdr, StrKey, nativeToScVal, hash, Networks } = stellarSdk;

    // Get recipient
    const recipient = paymentInfo.recipients?.stellar || paymentInfo.recipient;

    // Parse amount (7 decimals for Stellar USDC)
    const amountStroops = Math.floor(parseFloat(paymentInfo.amount) * 10_000_000);

    try {
      // Get current ledger from Soroban RPC
      const rpcResponse = await fetch(STELLAR_CONFIG.sorobanRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestLedger',
        }),
      });

      const rpcData = await rpcResponse.json();
      if (rpcData.error) {
        throw new Error(`Soroban RPC error: ${rpcData.error.message}`);
      }

      const currentLedger = rpcData.result.sequence;
      const signatureExpirationLedger = currentLedger + 60; // ~5 minutes

      // Generate random nonce
      const nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

      // Build authorization for transfer(from, to, amount)
      const fromAddress = new Address(this.publicKey);
      const toAddress = new Address(recipient);
      const amountScVal = nativeToScVal(BigInt(amountStroops), { type: 'i128' });

      const args = [fromAddress.toScVal(), toAddress.toScVal(), amountScVal];

      // Create contract address
      const contractIdBytes = StrKey.decodeContract(chainConfig.usdc.address);
      // @ts-ignore - Stellar SDK accepts Uint8Array
      const contractScAddress = Address.contract(contractIdBytes).toScAddress();

      // Build authorized invocation
      const contractFn = new xdr.InvokeContractArgs({
        contractAddress: contractScAddress,
        functionName: 'transfer',
        args: args,
      });

      const invocation = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(contractFn),
        subInvocations: [],
      });

      // Build HashIdPreimageSorobanAuthorization for signing
      // Cast to Buffer for hash() - Uint8Array is compatible at runtime
      const networkId = hash(stringToUint8Array(Networks.PUBLIC) as unknown as Buffer);

      const preimageData = new xdr.HashIdPreimageSorobanAuthorization({
        networkId: networkId,
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: signatureExpirationLedger,
        invocation: invocation,
      });

      const hashIdPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(preimageData);
      const preimageXdr = hashIdPreimage.toXDR('base64');

      // Sign with Freighter
      const signResult = await freighterApi.signAuthEntry(preimageXdr, {
        networkPassphrase: STELLAR_CONFIG.networkPassphrase,
      });

      if (signResult.error) {
        throw new X402Error(signResult.error, 'SIGNATURE_REJECTED');
      }

      if (!signResult.signedAuthEntry) {
        throw new X402Error('Freighter did not return signed auth entry', 'PAYMENT_FAILED');
      }

      // Build the signed SorobanAuthorizationEntry
      const signatureBytes = base64ToUint8Array(signResult.signedAuthEntry);
      const publicKeyBytes = StrKey.decodeEd25519PublicKey(this.publicKey);

      const sigMapEntries = [
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('public_key'),
          val: xdr.ScVal.scvBytes(publicKeyBytes),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('signature'),
          val: xdr.ScVal.scvBytes(signatureBytes as unknown as Buffer),
        }),
      ];

      const signatureScVal = xdr.ScVal.scvVec([xdr.ScVal.scvMap(sigMapEntries)]);

      const signedAddressCredentials = new xdr.SorobanAddressCredentials({
        address: fromAddress.toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: signatureExpirationLedger,
        signature: signatureScVal,
      });

      const signedCredentials = xdr.SorobanCredentials.sorobanCredentialsAddress(signedAddressCredentials);
      const signedAuthEntry = new xdr.SorobanAuthorizationEntry({
        credentials: signedCredentials,
        rootInvocation: invocation,
      });

      const authorizationEntryXdr = signedAuthEntry.toXDR('base64');

      const payload: StellarPaymentPayload = {
        from: this.publicKey,
        to: recipient,
        amount: amountStroops.toString(),
        tokenContract: chainConfig.usdc.address,
        authorizationEntryXdr,
        nonce,
        signatureExpirationLedger,
      };

      return JSON.stringify(payload);
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;

      if (error instanceof Error) {
        if (error.message.includes('User rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
        }
      }

      throw new X402Error(
        `Failed to create Stellar payment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    }
  }

  /**
   * Encode Stellar payment as X-PAYMENT header
   *
   * @param paymentPayload - JSON-encoded payment payload from signPayment()
   * @param version - x402 protocol version (1 or 2, defaults to 1)
   * @returns Base64-encoded X-PAYMENT header value
   */
  encodePaymentHeader(paymentPayload: string, version: X402Version = 1): string {
    const payload = JSON.parse(paymentPayload) as StellarPaymentPayload;

    // Build the payload data
    const payloadData = {
      from: payload.from,
      to: payload.to,
      amount: payload.amount,
      tokenContract: payload.tokenContract,
      authorizationEntryXdr: payload.authorizationEntryXdr,
      nonce: payload.nonce,
      signatureExpirationLedger: payload.signatureExpirationLedger,
    };

    // Format in x402 standard format (v1 or v2)
    const x402Payload = version === 2
      ? {
          x402Version: 2 as const,
          scheme: 'exact' as const,
          network: chainToCAIP2('stellar'), // CAIP-2 format for v2
          payload: payloadData,
        }
      : {
          x402Version: 1 as const,
          scheme: 'exact' as const,
          network: 'stellar', // Plain chain name for v1
          payload: payloadData,
        };

    return encodeBase64Json(x402Payload);
  }

  // Private helpers

  private async getFreighterApi(): Promise<typeof import('@stellar/freighter-api')> {
    const freighterApi = await import('@stellar/freighter-api');
    return freighterApi;
  }
}

export default StellarProvider;
