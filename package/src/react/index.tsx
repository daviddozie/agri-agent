/**
 * uvd-x402-sdk - React Hooks
 *
 * Provides React hooks for easy integration with x402 payments.
 *
 * @example
 * ```tsx
 * import { X402Provider, useX402, useBalance, usePayment } from 'uvd-x402-sdk/react';
 *
 * function App() {
 *   return (
 *     <X402Provider config={{ defaultChain: 'base' }}>
 *       <PaymentButton amount="10.00" recipient="0x..." />
 *     </X402Provider>
 *   );
 * }
 *
 * function PaymentButton({ amount, recipient }) {
 *   const { connect, isConnected, address } = useX402();
 *   const { balance, isLoading: balanceLoading } = useBalance();
 *   const { pay, isPaying } = usePayment();
 *
 *   if (!isConnected) {
 *     return <button onClick={() => connect('base')}>Connect Wallet</button>;
 *   }
 *
 *   return (
 *     <button
 *       onClick={() => pay({ amount, recipient })}
 *       disabled={isPaying}
 *     >
 *       Pay ${amount} USDC
 *     </button>
 *   );
 * }
 * ```
 */

import { createContext, useContext, useCallback, useState, useEffect, useMemo, type ReactNode } from 'react';
import { X402Client } from '../client';
import type {
  X402ClientConfig,
  WalletState,
  PaymentInfo,
  PaymentResult,
  ChainConfig,
  NetworkBalance,
} from '../types';
import { getEnabledChains, getChainByName } from '../chains';

// ============================================================================
// CONTEXT
// ============================================================================

interface X402ContextValue {
  client: X402Client;
  state: WalletState;
  connect: (chainName?: string) => Promise<string>;
  disconnect: () => Promise<void>;
  switchChain: (chainName: string) => Promise<void>;
  getBalance: () => Promise<string>;
}

const X402Context = createContext<X402ContextValue | null>(null);

// ============================================================================
// PROVIDER
// ============================================================================

interface X402ProviderProps {
  children: ReactNode;
  config?: X402ClientConfig;
}

/**
 * X402Provider - Context provider for x402 SDK
 *
 * Wrap your app with this provider to use the x402 hooks.
 */
export function X402Provider({ children, config }: X402ProviderProps) {
  const [client] = useState(() => new X402Client(config));
  const [state, setState] = useState<WalletState>(() => client.getState());

  useEffect(() => {
    // Subscribe to events
    const unsubConnect = client.on('connect', (newState) => {
      setState(newState);
    });

    const unsubDisconnect = client.on('disconnect', () => {
      setState(client.getState());
    });

    const unsubChainChanged = client.on('chainChanged', () => {
      setState(client.getState());
    });

    const unsubAccountChanged = client.on('accountChanged', () => {
      setState(client.getState());
    });

    return () => {
      unsubConnect();
      unsubDisconnect();
      unsubChainChanged();
      unsubAccountChanged();
    };
  }, [client]);

  const connect = useCallback(
    async (chainName?: string) => {
      const address = await client.connect(chainName);
      setState(client.getState());
      return address;
    },
    [client]
  );

  const disconnect = useCallback(async () => {
    await client.disconnect();
    setState(client.getState());
  }, [client]);

  const switchChain = useCallback(
    async (chainName: string) => {
      await client.switchChain(chainName);
      setState(client.getState());
    },
    [client]
  );

  const getBalance = useCallback(() => client.getBalance(), [client]);

  const value = useMemo(
    () => ({
      client,
      state,
      connect,
      disconnect,
      switchChain,
      getBalance,
    }),
    [client, state, connect, disconnect, switchChain, getBalance]
  );

  return <X402Context.Provider value={value}>{children}</X402Context.Provider>;
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * useX402 - Main hook for x402 functionality
 *
 * Returns wallet state and connection methods.
 */
export function useX402() {
  const context = useContext(X402Context);
  if (!context) {
    throw new Error('useX402 must be used within an X402Provider');
  }

  const { client, state, connect, disconnect, switchChain, getBalance } = context;

  return {
    // State
    isConnected: state.connected,
    address: state.address,
    chainId: state.chainId,
    network: state.network,
    networkType: state.networkType,

    // Methods
    connect,
    disconnect,
    switchChain,
    getBalance,

    // Client access for advanced usage
    client,
  };
}

/**
 * useBalance - Hook for USDC balance management
 */
export function useBalance() {
  const { client, isConnected, network } = useX402();
  const [balance, setBalance] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    if (!isConnected) {
      setBalance(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const bal = await client.getBalance();
      setBalance(bal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch balance');
      setBalance(null);
    } finally {
      setIsLoading(false);
    }
  }, [client, isConnected]);

  // Auto-fetch on connection/network change
  useEffect(() => {
    fetchBalance();
  }, [fetchBalance, network]);

  return {
    balance,
    isLoading,
    error,
    refetch: fetchBalance,
  };
}

/**
 * usePayment - Hook for creating payments
 */
export function usePayment() {
  const { client, isConnected } = useX402();
  const [isPaying, setIsPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<PaymentResult | null>(null);

  const pay = useCallback(
    async (paymentInfo: PaymentInfo): Promise<PaymentResult> => {
      if (!isConnected) {
        throw new Error('Wallet not connected');
      }

      setIsPaying(true);
      setError(null);

      try {
        const result = await client.createPayment(paymentInfo);
        setLastResult(result);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Payment failed';
        setError(message);
        throw err;
      } finally {
        setIsPaying(false);
      }
    },
    [client, isConnected]
  );

  const reset = useCallback(() => {
    setError(null);
    setLastResult(null);
  }, []);

  return {
    pay,
    isPaying,
    error,
    lastResult,
    reset,
  };
}

/**
 * useChains - Hook for chain information
 */
export function useChains() {
  const { network: currentNetwork } = useX402();

  const chains = useMemo(() => getEnabledChains(), []);

  const currentChain = useMemo(
    () => (currentNetwork ? getChainByName(currentNetwork) : null),
    [currentNetwork]
  );

  const evmChains = useMemo(
    () => chains.filter((c) => c.networkType === 'evm'),
    [chains]
  );

  const nonEvmChains = useMemo(
    () => chains.filter((c) => c.networkType !== 'evm'),
    [chains]
  );

  return {
    chains,
    currentChain,
    evmChains,
    nonEvmChains,
    getChain: getChainByName,
  };
}

/**
 * useNetworkBalances - Hook for fetching balances across all networks
 */
export function useNetworkBalances() {
  const { address, isConnected, networkType } = useX402();
  const [balances, setBalances] = useState<Map<string, NetworkBalance>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  const fetchAllBalances = useCallback(async () => {
    if (!isConnected || !address) {
      setBalances(new Map());
      return;
    }

    setIsLoading(true);
    const chains = getEnabledChains();

    // Filter to compatible chains
    const compatibleChains = chains.filter((chain) => {
      // EVM address starts with 0x
      if (address.startsWith('0x')) {
        return chain.networkType === 'evm';
      }
      // Otherwise match by network type
      return chain.networkType === networkType;
    });

    const newBalances = new Map<string, NetworkBalance>();

    // Initialize loading states
    compatibleChains.forEach((chain) => {
      newBalances.set(chain.name, {
        chainName: chain.name,
        displayName: chain.displayName,
        balance: null,
        isLoading: true,
        error: null,
      });
    });
    setBalances(new Map(newBalances));

    // Fetch in parallel
    await Promise.allSettled(
      compatibleChains.map(async (chain) => {
        try {
          const provider = new (await import('ethers')).JsonRpcProvider(chain.rpcUrl);
          const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
          const contract = new (await import('ethers')).Contract(
            chain.usdc.address,
            usdcAbi,
            provider
          );
          const balance = await contract.balanceOf(address);
          const formatted = parseFloat(
            (await import('ethers')).formatUnits(balance, chain.usdc.decimals)
          ).toFixed(2);

          newBalances.set(chain.name, {
            chainName: chain.name,
            displayName: chain.displayName,
            balance: formatted,
            isLoading: false,
            error: null,
          });
        } catch (err) {
          newBalances.set(chain.name, {
            chainName: chain.name,
            displayName: chain.displayName,
            balance: null,
            isLoading: false,
            error: err instanceof Error ? err.message : 'Failed',
          });
        }
        setBalances(new Map(newBalances));
      })
    );

    setIsLoading(false);
  }, [address, isConnected, networkType]);

  useEffect(() => {
    fetchAllBalances();
  }, [fetchAllBalances]);

  // Find network with highest balance
  const highestBalanceNetwork = useMemo(() => {
    let maxBalance = 0;
    let maxChain: string | null = null;

    balances.forEach((nb, chainName) => {
      if (nb.balance !== null && !nb.error) {
        const bal = parseFloat(nb.balance);
        if (bal > maxBalance) {
          maxBalance = bal;
          maxChain = chainName;
        }
      }
    });

    return maxChain;
  }, [balances]);

  return {
    balances,
    isLoading,
    refetch: fetchAllBalances,
    highestBalanceNetwork,
  };
}

// Re-export types for convenience
export type { WalletState, PaymentInfo, PaymentResult, ChainConfig, NetworkBalance };
