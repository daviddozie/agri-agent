import os
import time
import secrets
from eth_account import Account
from eth_account.messages import encode_typed_data
from hexbytes import HexBytes

# Base Sepolia USDC contract config
USDC_CONTRACT = os.getenv("USDC_CONTRACT_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")
CHAIN_ID = 84532  # Base Sepolia

# EIP-712 Types definition
TRANSFER_WITH_AUTHORIZATION_TYPES = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ]
}

def create_eip3009_payload(private_key: str, to_address: str, value_atoms: int, valid_seconds: int = 3600) -> dict:
    """
    Creates an EIP-3009 transferWithAuthorization payload.
    value_atoms: amount of USDC in micro-units (6 decimals, e.g. 0.05 USDC = 50000)
    """
    account = Account.from_key(private_key)
    from_address = account.address
    
    # Generate random 32-byte nonce
    nonce = "0x" + secrets.token_hex(32)
    
    now = int(time.time())
    valid_after = 0
    valid_before = now + valid_seconds
    
    domain_data = {
        "name": "USD Coin",
        "version": "2",
        "chainId": CHAIN_ID,
        "verifyingContract": USDC_CONTRACT,
    }
    
    message_data = {
        "from": from_address,
        "to": to_address,
        "value": int(value_atoms),
        "validAfter": int(valid_after),
        "validBefore": int(valid_before),
        "nonce": HexBytes(nonce),
    }
    
    # Sign typed data
    signable_msg = encode_typed_data(
        domain_data=domain_data,
        message_types=TRANSFER_WITH_AUTHORIZATION_TYPES,
        message_data=message_data
    )
    signed_msg = Account.sign_message(signable_msg, private_key=private_key)
    
    # Convert parameters to standard strings/hex for JSON serialization
    serialized_auth = {
        "from": from_address,
        "to": to_address,
        "value": str(value_atoms),
        "validAfter": str(valid_after),
        "validBefore": str(valid_before),
        "nonce": nonce,
    }
    
    return {
        "authorization": serialized_auth,
        "signature": signed_msg.signature.hex(),
        "domain": domain_data
    }

def verify_eip3009_signature(payload: dict) -> str:
    """
    Recovers the signer (from address) of an EIP-3009 payload.
    Returns the recovered address as a hex string.
    """
    auth = payload["authorization"]
    signature = payload["signature"]
    domain = payload.get("domain") or {
        "name": "USD Coin",
        "version": "2",
        "chainId": CHAIN_ID,
        "verifyingContract": USDC_CONTRACT,
    }
    
    domain_data = {
        "name": domain.get("name", "USD Coin"),
        "version": domain.get("version", "2"),
        "chainId": int(domain.get("chainId", CHAIN_ID)),
        "verifyingContract": domain.get("verifyingContract", USDC_CONTRACT),
    }
    
    message_data = {
        "from": auth["from"],
        "to": auth["to"],
        "value": int(auth["value"]),
        "validAfter": int(auth["validAfter"]),
        "validBefore": int(auth["validBefore"]),
        "nonce": HexBytes(auth["nonce"]),
    }
    
    signable_msg = encode_typed_data(
        domain_data=domain_data,
        message_types=TRANSFER_WITH_AUTHORIZATION_TYPES,
        message_data=message_data
    )
    recovered_addr = Account.recover_message(signable_msg, signature=signature)
    return recovered_addr
